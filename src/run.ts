import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import {
  exec,
  getExecOutput,
  type ExecOptions,
  type ExecOutput,
} from "@actions/exec";
import { context } from "@actions/github";
import semver from "semver";
import type { GitHub } from "./github.ts";
import type { Octokit } from "./octokit.ts";
import { commentReleasedPrs as commentReleasedPrsOn } from "./releasedComments.ts";
import {
  execShiprig,
  getExecOutputShiprig,
  listPackages,
  FIRST_RELEASE,
  plannedTags,
  readChangelog,
  readPreState,
  readReleasePlan,
  type ShiprigPackage,
  workspaceRoot,
} from "./shiprig.ts";
import { getChangelogEntry, sortTheThings } from "./utils.ts";

// GitHub Issues/PRs messages have a max size limit on the
// message body payload.
// `body is too long (maximum is 65536 characters)`.
// To avoid that, we ensure to cap the message to 60k chars.
const MAX_CHARACTERS_PER_MESSAGE = 60000;

/**
 * What a GitHub release does when its package's changelog has no entry for
 * the version: fail (`error`, the default, checked before publishing too),
 * let GitHub write the notes from the merged PRs (`generate`), or create no
 * release (`skip`).
 */
export type ReleaseNotesFallback = "error" | "generate" | "skip";

const createRelease = async (
  octokit: Octokit,
  {
    pkg,
    tagName,
    releaseNotesFallback,
  }: {
    pkg: ShiprigPackage;
    tagName: string;
    releaseNotesFallback: ReleaseNotesFallback;
  },
): Promise<boolean> => {
  const changelog = await readChangelog(pkg);
  if (changelog === undefined) {
    // if we can't find a changelog, the user has probably disabled changelogs
    return false;
  }
  const changelogEntry = getChangelogEntry(changelog, pkg.version);
  const release = {
    name: tagName,
    tag_name: tagName,
    prerelease: pkg.version.includes("-"),
    ...context.repo,
  };
  if (!changelogEntry.found) {
    // Without its heading, the entry's content is the whole changelog, which
    // is no release's notes.
    if (releaseNotesFallback === "skip") {
      core.warning(
        `No changelog entry for ${pkg.name}@${pkg.version}; not creating the ${tagName} release (release-notes-fallback: skip).`,
      );
      return false;
    }
    if (releaseNotesFallback === "generate") {
      core.warning(
        `No changelog entry for ${pkg.name}@${pkg.version}; the ${tagName} release gets notes GitHub generates (release-notes-fallback: generate).`,
      );
      await octokit.rest.repos.createRelease({
        ...release,
        generate_release_notes: true,
      });
      return true;
    }
    throw new Error(
      `Could not find changelog entry for ${pkg.name}@${pkg.version}`,
    );
  }

  await octokit.rest.repos.createRelease({
    ...release,
    body: changelogEntry.content,
  });
  return true;
};

/**
 * The packages a publish would tag, each with its tag, from `shiprig tag
 * --dry-run`. A tag is matched to its package as shiprig names it,
 * `<name>@<version>`, or `v<version>` for the one package at that version (a
 * single-package repository). Undefined when shiprig couldn't say.
 */
async function packagesToTag(
  cwd: string,
  packages: ShiprigPackage[],
): Promise<{ pkg: ShiprigPackage; tag: string }[] | undefined> {
  const tags = await plannedTags(cwd);
  if (tags === undefined) return undefined;
  return tags.flatMap((tag) => {
    const named = packages.find((p) => tag === `${p.name}@${p.version}`);
    if (named) return [{ pkg: named, tag }];
    const atVersion = packages.filter(
      (p) => !p.ignored && tag === `v${p.version}`,
    );
    if (atVersion.length === 1) return [{ pkg: atVersion[0], tag }];
    core.debug(`No package matches the tag ${tag}; not checking it.`);
    return [];
  });
}

/**
 * Of the packages about to be tagged, those whose changelog exists but has no
 * entry for their version: each would fail its GitHub release once it was
 * already published. A package with no changelog at all gets no release, so
 * it isn't one.
 */
async function missingChangelogEntries(
  toTag: { pkg: ShiprigPackage; tag: string }[],
): Promise<ShiprigPackage[]> {
  const missing: ShiprigPackage[] = [];
  for (const { pkg } of toTag) {
    const changelog = await readChangelog(pkg);
    if (
      changelog !== undefined &&
      !getChangelogEntry(changelog, pkg.version).found
    ) {
      missing.push(pkg);
    }
  }
  return missing;
}

type PublishOptions = {
  script?: string;
  fromPackDir?: string;
  createGithubReleases: boolean;
  pushGitTags: boolean;
  // Comment "released in" on the pull requests whose changesets shipped.
  commentReleasedPrs?: boolean;
  // A changelog with no entry for the released version. Default: error.
  releaseNotesFallback?: ReleaseNotesFallback;
  // Run `shiprig publish --dry-run` and report what would be tagged and
  // released, publishing, pushing and creating nothing.
  dryRun?: boolean;
  github: GitHub;
  cwd: string;
};

type PublishedPackage = { name: string; version: string };
type ChangesetsOutputEvent = {
  type: "git-tag";
  tag: string;
  packageName: string;
};

class ChangesetsOutputReadError extends Error {}

type PublishResult =
  | {
      published: true;
      publishedPackages: PublishedPackage[];
      // The same packages with their tags, for the job summary; the
      // published-packages output keeps upstream's shape.
      released: (PublishedPackage & { tag: string })[];
      exitCode: number;
    }
  | {
      published: false;
      exitCode: number;
      // A dry run's report: what a real run would tag, and whether each
      // would get a GitHub release. Undefined when the action couldn't tell
      // what would be tagged.
      wouldRelease?: (PublishedPackage & { tag: string; release: boolean })[];
    };

function isObject(value: unknown) {
  return typeof value === "object" && value !== null;
}

function isChangesetsOutputEvent(
  value: unknown,
): value is ChangesetsOutputEvent {
  return (
    isObject(value) &&
    "type" in value &&
    value.type === "git-tag" &&
    "tag" in value &&
    typeof value.tag === "string" &&
    "packageName" in value &&
    typeof value.packageName === "string"
  );
}

async function readChangesetsOutput(outputPath: string) {
  let rawOutput: string;
  try {
    rawOutput = await fs.readFile(outputPath, "utf8");
  } catch (err) {
    throw new ChangesetsOutputReadError(
      `Failed to read changesets output at ${outputPath}`,
      { cause: err },
    );
  }

  const events: ChangesetsOutputEvent[] = [];

  let lineStart = 0;
  while (lineStart <= rawOutput.length) {
    let lineEnd = rawOutput.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      lineEnd = rawOutput.length;
    }
    const line = rawOutput.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;

    if (/^\s*$/.test(line)) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (err) {
      throw new Error(`Failed to parse changesets output event: ${line}`, {
        cause: err,
      });
    }

    if (!isChangesetsOutputEvent(event)) {
      continue;
    }

    events.push(event);
  }

  return events;
}

export async function runPublish({
  script,
  fromPackDir,
  github,
  createGithubReleases,
  pushGitTags,
  commentReleasedPrs = false,
  releaseNotesFallback = "error",
  dryRun = false,
  cwd,
}: PublishOptions): Promise<PublishResult> {
  const { octokit } = github;

  // Checked before publishing, which can't be undone: a package list that
  // fails validation stops the run while nothing has gone out yet, not after,
  // when the tags it published would be left unreported. It's read again once
  // the script has run (below), since a custom script may change versions.
  const packagesBefore = await listPackages(cwd);

  // So is every release's changelog entry: a missing one used to surface
  // only at its GitHub release, after the packages were published and the
  // tags pushed, leaving a release that can't be run again.
  const toTag =
    createGithubReleases || dryRun
      ? await packagesToTag(cwd, packagesBefore)
      : [];
  if (toTag === undefined && createGithubReleases) {
    // Unknown is not "none missing": with `error`, a missing entry must stop
    // the run here, so an unreadable answer stops it too.
    if (releaseNotesFallback === "error") {
      throw new Error(
        "Couldn't read which tags `shiprig tag --dry-run` would create, so the changelog entries the GitHub releases need couldn't be checked. Nothing was published. " +
          "Check that shiprig runs here, or set release-notes-fallback to `generate` or `skip` to publish without the check.",
      );
    }
    core.warning(
      `Couldn't read what \`shiprig tag --dry-run\` would tag, so changelog entries weren't checked before publishing (release-notes-fallback: ${releaseNotesFallback}).`,
    );
  }
  const missing =
    createGithubReleases && toTag ? await missingChangelogEntries(toTag) : [];
  if (missing.length > 0) {
    const list = missing
      .map(
        (p) =>
          `${p.name}@${p.version} (${path.relative(cwd, p.changelog) || p.changelog})`,
      )
      .join(", ");
    if (releaseNotesFallback === "error") {
      throw new Error(
        `No changelog entry for the version about to be released: ${list}. Nothing was published. ` +
          "Add a `## <version>` entry to each changelog, or set release-notes-fallback to `generate` or `skip`.",
      );
    }
    core.warning(
      `No changelog entry for the version about to be released: ${list}. Their GitHub releases ${
        releaseNotesFallback === "generate"
          ? "get notes GitHub generates"
          : "are skipped"
      } (release-notes-fallback: ${releaseNotesFallback}).`,
    );
  }

  if (dryRun) {
    return publishDryRun({
      script,
      fromPackDir,
      github,
      createGithubReleases,
      pushGitTags,
      releaseNotesFallback,
      cwd,
      toTag,
    });
  }

  // Changesets creates annotated tags locally, including when the action pushes those tags through the GitHub API.
  // It might also be important for custom publish scripts to have a valid git user configured.
  await github.ensureGitUser();

  let changesetPublishOutput: ExecOutput;
  const outputFile = path.join(
    process.env.RUNNER_TEMP ?? (await fs.realpath(os.tmpdir())),
    `changesets-output-${randomUUID()}.ndjson`,
  );
  const execOptions: ExecOptions = {
    cwd,
    ignoreReturnCode: true,
    env: {
      ...process.env,
      GITHUB_TOKEN: github.getToken(),
      CHANGESETS_OUTPUT: outputFile,
    },
  };

  if (script) {
    changesetPublishOutput = await getExecOutput(
      script,
      undefined,
      execOptions,
    );
  } else {
    // From a pack directory, shiprig publishes the files `shiprig pack` built
    // (checked against their recorded integrity), building nothing.
    const args = ["publish", "--yes"];
    if (fromPackDir) {
      args.push("--from-pack-dir", fromPackDir);
    }
    changesetPublishOutput = await getExecOutputShiprig(args, execOptions);
  }

  // The versions as they stand after the script, which is what its tag
  // events name.
  let packages = await listPackages(cwd);
  let packagesByName = new Map(packages.map((x) => [x.name, x]));
  let output: ChangesetsOutputEvent[];
  try {
    output = await readChangesetsOutput(outputFile);
  } catch (err) {
    if (!script || !(err instanceof ChangesetsOutputReadError)) {
      throw err;
    }
    core.warning(
      `${err.message}. GitHub releases and git tags cannot be created without this output. Ensure the custom publish script runs \`shiprig publish\` (or \`shiprig tag\`) with CHANGESETS_OUTPUT in its environment.`,
    );
    output = [];
  }
  let releases = output.map((event) => {
    let pkg = packagesByName.get(event.packageName);
    if (pkg === undefined) {
      throw new Error(
        `Package "${event.packageName}" not found.` +
          "This is probably a bug in the action, please open an issue",
      );
    }
    return { pkg, tag: event.tag };
  });

  // The tags whose GitHub release this run created.
  const withRelease = new Set<string>();
  if (createGithubReleases || pushGitTags) {
    await Promise.all(
      releases.map(async ({ pkg, tag }) => {
        if (pushGitTags) {
          await github.pushTag(tag);
        }
        if (createGithubReleases) {
          if (
            await createRelease(octokit, {
              pkg,
              tagName: tag,
              releaseNotesFallback,
            })
          ) {
            withRelease.add(tag);
          }
        }
      }),
    );
  }

  // Only once the tags are on GitHub: a comment links each release. When the
  // run creates releases, a package that got none (release-notes-fallback:
  // skip, or no changelog) isn't named, as its link would lead nowhere.
  const commented = createGithubReleases
    ? releases.filter(({ tag }) => withRelease.has(tag))
    : releases;
  if (commentReleasedPrs && pushGitTags && commented.length) {
    await commentReleasedPrsOn({
      octokit,
      sha: context.sha,
      released: await Promise.all(
        commented.map(async ({ pkg, tag }) => {
          const entry = getChangelogEntry(
            (await readChangelog(pkg)) ?? "",
            pkg.version,
          );
          return {
            name: pkg.name,
            version: pkg.version,
            tag,
            // No heading for this version: the rest of the changelog is
            // older releases, whose PRs this one didn't ship.
            notes: entry.found ? entry.content : undefined,
          };
        }),
      ),
      serverUrl: github.serverUrl,
    });
  }

  if (releases.length) {
    return {
      published: true,
      publishedPackages: releases.map(({ pkg }) => ({
        name: pkg.name,
        version: pkg.version,
      })),
      released: releases.map(({ pkg, tag }) => ({
        name: pkg.name,
        version: pkg.version,
        tag,
      })),
      exitCode: changesetPublishOutput.exitCode,
    };
  }

  return { published: false, exitCode: changesetPublishOutput.exitCode };
}

/**
 * The publish path's dry run: `shiprig publish --dry-run` shows what would go
 * to each registry, and the log says which tags would be pushed and releases
 * created. A custom publish script isn't run: the action can't know it honors
 * a dry-run flag, and one that ignored it would publish for real.
 */
async function publishDryRun({
  script,
  fromPackDir,
  github,
  createGithubReleases,
  pushGitTags,
  releaseNotesFallback = "error",
  cwd,
  toTag,
}: Omit<PublishOptions, "commentReleasedPrs"> & {
  toTag: { pkg: ShiprigPackage; tag: string }[] | undefined;
}): Promise<PublishResult> {
  if (script) {
    core.info(
      `Dry run: not running the publish script (${script}); \`shiprig publish --dry-run\` shows what shiprig would publish instead.`,
    );
  }
  const args = ["publish", "--dry-run"];
  if (fromPackDir) {
    args.push("--from-pack-dir", fromPackDir);
  }
  const output = await getExecOutputShiprig(args, {
    cwd,
    ignoreReturnCode: true,
    env: {
      ...process.env,
      GITHUB_TOKEN: github.getToken(),
      // No events: nothing is tagged, so there's nothing to push or release.
      CHANGESETS_OUTPUT: "",
    },
  });
  if (toTag === undefined) {
    // Not "nothing": the action couldn't tell.
    core.warning(
      "Dry run: couldn't read which tags `shiprig tag --dry-run` would create, so this can't say what a real run would tag or release. `shiprig publish --dry-run` above shows what shiprig would publish.",
    );
    return { published: false, exitCode: output.exitCode };
  }
  const wouldRelease: NonNullable<
    Extract<PublishResult, { published: false }>["wouldRelease"]
  > = [];
  for (const { pkg, tag } of toTag) {
    // As createRelease decides: no changelog, or no entry with `skip`, means
    // no release.
    const changelog = await readChangelog(pkg);
    const hasEntry =
      changelog !== undefined &&
      getChangelogEntry(changelog, pkg.version).found;
    const release =
      createGithubReleases &&
      changelog !== undefined &&
      (hasEntry || releaseNotesFallback === "generate");
    const actions = [
      pushGitTags && `push the tag ${tag}`,
      release &&
        `create the ${tag} GitHub release${hasEntry ? "" : " with notes GitHub generates"}`,
    ].filter(Boolean);
    core.info(
      `Dry run: ${pkg.name}@${pkg.version} would be released${
        actions.length ? `; the action would ${actions.join(" and ")}` : ""
      }${createGithubReleases && !release ? `, with no GitHub release (${changelog === undefined ? "no changelog" : "release-notes-fallback: skip"})` : ""}.`,
    );
    wouldRelease.push({
      name: pkg.name,
      version: pkg.version,
      tag,
      release,
    });
  }
  if (toTag.length === 0) {
    core.info("Dry run: nothing would be tagged or released.");
  }
  return { published: false, exitCode: output.exitCode, wouldRelease };
}

type GetMessageOptions = {
  hasPublishScript: boolean;
  branch: string;
  changedPackagesInfo: {
    highestLevel: number;
    private: boolean;
    content: string;
    header: string;
  }[];
  prBodyMaxCharacters: number;
  preState?: { tag: string };
};

export async function getVersionPrBody({
  hasPublishScript,
  preState,
  changedPackagesInfo,
  prBodyMaxCharacters,
  branch,
}: GetMessageOptions) {
  let messageHeader = `This PR was opened by the [shiprig release](https://github.com/rigsmith/shiprig-action) GitHub action. When you're ready to do a release, you can merge this and ${
    hasPublishScript
      ? `the packages will be published automatically`
      : `publish them yourself or [set up this action to publish automatically](https://github.com/rigsmith/shiprig-action#with-publishing)`
  }. If you're not ready to do a release yet, that's fine, whenever you add more changesets to ${branch}, this PR will be updated.
`;
  let messagePrestate = !!preState
    ? `⚠️⚠️⚠️⚠️⚠️⚠️

\`${branch}\` is currently in **pre mode** so this branch has prereleases rather than normal releases. If you want to exit prereleases, run \`shiprig pre exit\` on \`${branch}\`.

⚠️⚠️⚠️⚠️⚠️⚠️
`
    : "";
  let messageReleasesHeading = `# Releases`;

  let fullMessage = [
    messageHeader,
    messagePrestate,
    messageReleasesHeading,
    ...changedPackagesInfo.map((info) => `${info.header}\n\n${info.content}`),
  ].join("\n");

  // Check that the message does not exceed the size limit.
  // If not, omit the changelog entries of each package.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> The changelog information of each package has been omitted from this message, as the content exceeds the size limit.\n`,
      ...changedPackagesInfo.map((info) => `${info.header}\n\n`),
    ].join("\n");
  }

  // Check (again) that the message is within the size limit.
  // If not, omit all release content this time.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> All release information have been omitted from this message, as the content exceeds the size limit.`,
    ].join("\n");
  }

  return fullMessage;
}

type VersionOptions = {
  script?: string;
  github: GitHub;
  cwd?: string;
  prTitle?: string;
  commitMessage?: string;
  hasPublishScript?: boolean;
  prBodyMaxCharacters?: number;
  prDraft?: "always" | "create";
  branch?: string;
  // A label on the version PR that freezes its branch, for hand edits.
  holdLabel?: string;
  // Release packages at exact versions (`releaseAs` in shiprig-action.jsonc).
  releaseAs?: Record<string, string>;
  // A version PR per release group instead of one for everything.
  separatePullRequests?: boolean;
  // Print the plan and the PR it would open; change nothing.
  dryRun?: boolean;
  // Set by runVersion: the packages releasing at their current version.
  firstRelease?: string[];
};

type RunVersionResult = {
  // Undefined when the run left the version PR alone (stale, or held). With
  // a version PR per group, the first group's.
  pullRequestNumber?: number;
  // Every version PR this run opened or updated (or left held), one per
  // group; just the one otherwise.
  pullRequestNumbers?: number[];
  // Why the version PR was left alone, when it was.
  skipped?: "stale" | "held";
  // Every package this run versioned, from and to. The job summary shows
  // these rather than the plan's, which was read before the run: releaseAs
  // moves the named package and any sharing its version file.
  versions?: VersionChange[];
  // A dry run's report: each version PR a real run would open or update.
  dryRun?: {
    branch: string;
    title: string;
    pullRequestNumber?: number;
    held: boolean;
  }[];
};

/** A package this run versioned: its version before, and after. */
export type VersionChange = { name: string; from: string; to: string };

export async function runVersion(
  options: VersionOptions,
): Promise<RunVersionResult> {
  const { script, releaseAs, separatePullRequests } = options;
  // A custom version script decides versions itself; releaseAs can't reach it.
  if (script && releaseAs && Object.keys(releaseAs).length > 0) {
    throw new Error(
      "`releaseAs` in shiprig-action.jsonc can't be combined with a custom version-script: " +
        "the script runs its own version command. Pass `--release-as <package>=<version>` to shiprig in the script instead.",
    );
  }
  if (separatePullRequests && script) {
    throw new Error(
      "separate-pull-requests can't be combined with a custom version-script: each PR versions one release group with `shiprig version --only`, which the script doesn't run.",
    );
  }
  const branch = options.branch ?? context.ref.replace("refs/heads/", "");
  const versionBranch = `changeset-release/${branch}`;
  const firstRelease = await firstReleases(
    options.cwd ?? process.cwd(),
    releaseAs,
  );
  if (options.dryRun) {
    return versionDryRun({ ...options, branch, versionBranch, firstRelease });
  }
  if (!separatePullRequests) {
    const result = await runVersionBranch({
      ...options,
      branch,
      versionBranch,
      firstRelease,
    });
    return {
      ...result,
      pullRequestNumbers:
        result.pullRequestNumber === undefined
          ? []
          : [result.pullRequestNumber],
    };
  }
  return runVersionPerGroup({
    ...options,
    branch,
    versionBranch,
    firstRelease,
  });
}

/**
 * The packages `releaseAs` names at their own current version, still
 * unreleased: a first release at the version already on disk (`shiprig
 * version --release-as <pkg>=<current>`, which writes its changelog entry
 * with no bump). Unreleased means the changelog has no entry for that
 * version (or there's no changelog yet), which is exactly what the version
 * run writes, so once the version PR merges the package publishes instead of
 * being versioned again. A package `shiprig tag --dry-run` wouldn't tag (its
 * tag exists) is released already, whatever its changelog says. Nothing in
 * pre mode, where releaseAs waits.
 */
export async function firstReleases(
  cwd: string,
  releaseAs: Record<string, string> | undefined,
): Promise<string[]> {
  const entries = Object.entries(releaseAs ?? {});
  if (entries.length === 0) return [];
  if ((await readPreState(cwd))?.mode === "pre") return [];
  const packages = await listPackages(cwd);
  const candidates: ShiprigPackage[] = [];
  for (const [name, version] of entries) {
    const pkg = packages.find((p) => p.name === name);
    if (!pkg || pkg.ignored || !sameVersion(pkg.version, version)) continue;
    const changelog = await readChangelog(pkg);
    if (
      changelog !== undefined &&
      getChangelogEntry(changelog, pkg.version).found
    ) {
      continue;
    }
    candidates.push(pkg);
  }
  if (candidates.length === 0) return [];
  // The changelog entry is what marks the version as versioned: without
  // changelogs, the merge of the version PR would version it again instead
  // of publishing it, on every push until it's tagged.
  // So with changelogs off, it isn't one, and the run goes on as it would.
  if (await changelogsDisabled(cwd)) {
    core.warning(
      `releaseAs names ${candidates.map((p) => `${p.name}@${p.version}`).join(", ")} at the version already on disk, but changelogs are off ("changelog": false in .changeset/config.json), and a first release needs changelogs: the changelog entry the version PR writes is how the action knows the version is ready to publish. ` +
        "Not treating it as a first release. Turn changelogs on, or publish this version another way and remove the releaseAs entry.",
    );
    return [];
  }
  // Only on evidence that the tag is missing: an unknown answer could hide a
  // released version, which a first release would then pass to shiprig.
  const toTag = await packagesToTag(cwd, packages);
  if (toTag === undefined) {
    core.warning(
      `Couldn't read which tags \`shiprig tag --dry-run\` would create, so releaseAs at the current version (${candidates.map((p) => p.name).join(", ")}) isn't treated as a first release.`,
    );
    return [];
  }
  return candidates
    .filter((pkg) => toTag.some((t) => t.pkg === pkg))
    .map((pkg) => pkg.name);
}

/** Whether .changeset/config.json turns changelogs off. */
async function changelogsDisabled(cwd: string): Promise<boolean> {
  try {
    const config = JSON.parse(
      await fs.readFile(
        path.join(await workspaceRoot(cwd), ".changeset", "config.json"),
        "utf8",
      ),
    );
    return config?.changelog === false;
  } catch {
    // No config, or one shiprig would refuse itself: not this check's to judge.
    return false;
  }
}

function sameVersion(a: string, b: string): boolean {
  return semver.valid(a) && semver.valid(b) ? semver.eq(a, b) : a === b;
}

/**
 * The version path's dry run: `shiprig version --dry-run` prints the plan
 * without writing a file, and the log says which version PR would be opened
 * or updated, under what title. Nothing is committed, pushed or opened; the
 * version PRs are only listed. A custom version script isn't run, as it would
 * write the files `--dry-run` leaves alone.
 */
async function versionDryRun({
  script,
  github,
  cwd = process.cwd(),
  prTitle,
  holdLabel = "release:hold",
  releaseAs,
  separatePullRequests,
  branch,
  versionBranch,
  firstRelease = [],
}: VersionOptions & {
  branch: string;
  versionBranch: string;
}): Promise<RunVersionResult> {
  const { octokit } = github;
  if (script) {
    core.info(
      `Dry run: not running the version script (${script}); \`shiprig version --dry-run\` shows the plan instead.`,
    );
  }
  const pre = await readPreState(cwd);
  const preState = pre?.mode === "pre" ? pre : undefined;
  const args = ["version", "--dry-run"];
  const overrides = new Map<string, string>();
  for (const spec of releaseAsArgs(
    releaseAs,
    await listPackages(cwd),
    preState,
    firstRelease,
  )) {
    args.push("--release-as", spec);
    const at = spec.lastIndexOf("=");
    overrides.set(spec.slice(0, at), spec.slice(at + 1));
  }
  await execShiprig(args, {
    cwd,
    env: { ...process.env, GITHUB_TOKEN: github.getToken() },
  });

  // One PR for everything, or one per release group. A first release isn't
  // in shiprig's plan (nothing bumps it); it releases on its own.
  // The plan is read before releaseAs applies: report the versions the
  // overrides set, as the real run's PR would.
  const plan = (await readReleasePlan(cwd))
    .filter((r) => r.type !== "none")
    .map((r) =>
      overrides.has(r.name) ? { ...r, newVersion: overrides.get(r.name)! } : r,
    );
  for (const name of firstRelease) {
    if (!plan.some((r) => r.name === name)) {
      plan.push({ name, type: FIRST_RELEASE, newVersion: releaseAs![name] });
    }
  }
  const prs = new Map<string, typeof plan>();
  for (const r of plan) {
    const head = separatePullRequests
      ? `${versionBranch}/${branchSlug(r.group ?? r.name)}`
      : versionBranch;
    prs.set(head, [...(prs.get(head) ?? []), r]);
  }

  const dryRun: NonNullable<RunVersionResult["dryRun"]> = [];
  for (const [head, releases] of [...prs].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const title =
      prTitle !== undefined
        ? `${prTitle}${preState ? ` (${preState.tag})` : ""}`
        : releaseTitle(
            releases.map((r) => ({ name: r.name, version: r.newVersion })),
          );
    const { data: open } = await octokit.rest.pulls.list({
      ...context.repo,
      state: "open",
      head: `${context.repo.owner}:${head}`,
      base: branch,
    });
    const existing = open[0];
    const held = open.some((p) =>
      (p.labels ?? []).some((l) => l.name === holdLabel),
    );
    core.info(
      held
        ? `Dry run: the version PR #${existing.number} (${head}) has the "${holdLabel}" label, so a real run would leave it alone.`
        : existing
          ? `Dry run: would push ${head} and update the version PR #${existing.number} to "${title}".`
          : `Dry run: would push ${head} and open a version PR into ${branch}, "${title}".`,
    );
    dryRun.push({
      branch: head,
      title,
      pullRequestNumber: existing?.number,
      held,
    });
  }
  if (dryRun.length === 0) {
    core.info("Dry run: nothing would release, so no version PR.");
  }
  return { pullRequestNumbers: [], dryRun };
}

/**
 * A version PR per release group (release-please's separate-pull-requests):
 * each group of packages that must move together (`shiprig status
 * --output`'s group) gets its own branch, `changeset-release/<base>/<group>`,
 * versioned with `shiprig version --only`, so an app and a library can
 * release on their own schedules. A group's PR is held, left stale and
 * rebuilt exactly as the single version PR is. PRs for groups that no longer
 * release are closed, unless held.
 */
async function runVersionPerGroup(
  options: VersionOptions & { branch: string; versionBranch: string },
): Promise<RunVersionResult> {
  const { github, branch, versionBranch } = options;
  const cwd = options.cwd ?? process.cwd();
  const { octokit } = github;
  const holdLabel = options.holdLabel ?? "release:hold";

  const plan = await readReleasePlan(cwd);
  if (plan.length > 0 && plan.every((r) => r.group === undefined)) {
    throw new Error(
      "separate-pull-requests needs shiprig 1.22.0 or later, whose `status --output` reports each package's release group.",
    );
  }
  const groups = new Map<string, string[]>();
  for (const r of plan) {
    const group = r.group ?? r.name;
    groups.set(group, [...(groups.get(group) ?? []), r.name]);
  }
  // A first release isn't in the plan: it gets a group of its own.
  const firstRelease = options.firstRelease ?? [];
  for (const name of firstRelease) {
    if (!plan.some((r) => r.name === name)) groups.set(name, [name]);
  }

  const branches = new Set<string>();
  const numbers: number[] = [];
  const versions: VersionChange[] = [];
  let ran = 0;
  let held = 0;
  let first = true;
  for (const group of [...groups.keys()].sort()) {
    const members = groups.get(group)!;
    // Nothing in the group actually releases (range-only rewrites alone).
    if (
      !plan.some((r) => members.includes(r.name) && r.type !== "none") &&
      !members.some((name) => firstRelease.includes(name))
    ) {
      continue;
    }
    const groupBranch = `${versionBranch}/${branchSlug(group)}`;
    if (branches.has(groupBranch)) {
      throw new Error(
        `Two release groups would share the branch ${groupBranch} (group names differing only in punctuation, like @acme/lib and acme-lib). Rename one of the packages, or leave separate-pull-requests off.`,
      );
    }
    branches.add(groupBranch);
    if (!first) await github.resetToBase();
    first = false;
    const result = await runVersionBranch({
      ...options,
      versionBranch: groupBranch,
      only: members,
    });
    if (result.skipped === "stale") {
      return { skipped: "stale" };
    }
    ran++;
    if (result.skipped === "held") held++;
    if (result.pullRequestNumber !== undefined) {
      numbers.push(result.pullRequestNumber);
    }
    versions.push(...(result.versions ?? []));
  }

  // A group that no longer releases (it merged, or its packages regrouped)
  // leaves an open PR behind; so does the single version PR after switching
  // to separate ones. Close them, but never a held one: that's someone's.
  const { data: open } = await octokit.rest.pulls.list({
    ...context.repo,
    state: "open",
    base: branch,
    per_page: 100,
  });
  for (const pr of open) {
    const ref = pr.head.ref;
    const ours =
      pr.head.repo?.full_name ===
        `${context.repo.owner}/${context.repo.repo}` &&
      (ref === versionBranch || ref.startsWith(`${versionBranch}/`));
    if (!ours || branches.has(ref)) continue;
    if ((pr.labels ?? []).some((l) => l.name === holdLabel)) {
      core.info(
        `#${pr.number} (${ref}) no longer matches a release group, but it has the "${holdLabel}" label, so it stays open.`,
      );
      continue;
    }
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pr.number,
      body: "Closing: nothing in this version PR's release group is pending any more (it was released, or its packages now release with another group). An open version PR per group is kept up to date on every push.",
    });
    await octokit.rest.pulls.update({
      ...context.repo,
      pull_number: pr.number,
      state: "closed",
    });
    core.info(
      `Closed #${pr.number} (${ref}): its release group has nothing pending.`,
    );
  }

  return {
    pullRequestNumber: numbers[0],
    pullRequestNumbers: numbers,
    versions,
    // Held only when every group was: otherwise the run did update PRs.
    skipped: ran > 0 && held === ran ? "held" : undefined,
  };
}

/** A group name as a branch path segment: @acme/lib becomes acme-lib. */
export function branchSlug(group: string): string {
  return (
    group
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .replace(/\.\.+/g, ".")
      // Git refuses a ref component ending .lock.
      .replace(/\.lock$/, "-lock") || "group"
  );
}

/** One version PR: versionBranch, versioning only `only` when given. */
async function runVersionBranch({
  script,
  github,
  cwd = process.cwd(),
  prTitle,
  commitMessage,
  hasPublishScript = false,
  prBodyMaxCharacters = MAX_CHARACTERS_PER_MESSAGE,
  branch = context.ref.replace("refs/heads/", ""),
  prDraft,
  holdLabel = "release:hold",
  releaseAs,
  versionBranch,
  only,
  firstRelease = [],
}: VersionOptions & {
  versionBranch: string;
  only?: string[];
}): Promise<RunVersionResult> {
  const { octokit } = github;

  // Release workflows queue their runs (queue: max) rather than drop them, and
  // GitHub doesn't guarantee the order they start in. A run that starts after
  // a newer one would reset the version branch to its older commit, or reopen
  // a version PR that was just merged. If the base has moved past this run's
  // commit, the newer run owns the version PR, so this one leaves it alone.
  // Checked before any work, and again just before the push, since the base
  // can move while this run is versioning. What's checked is the branch the
  // run is on (its commit is that branch's), which is the base unless
  // pr-base-branch names another; a run that isn't on a branch has nothing
  // newer to defer to.
  const runBranch = context.ref.startsWith("refs/heads/")
    ? context.ref.slice("refs/heads/".length)
    : undefined;
  const stale = async () => {
    if (runBranch === undefined) return false;
    const newerHead = await github.baseMovedPast(runBranch, context.sha);
    if (newerHead === undefined) return false;
    core.info(
      `${runBranch} has moved on to ${newerHead.slice(0, 7)} since this run's commit ` +
        `(${context.sha.slice(0, 7)}); the run for that commit updates the version PR, so this one leaves it alone.`,
    );
    return true;
  };
  if (await stale()) {
    return { skipped: "stale" };
  }

  // A held version PR's branch is someone's to edit by hand: leave it be.
  const listVersionPrs = async () =>
    (
      await octokit.rest.pulls.list({
        ...context.repo,
        state: "open",
        head: `${context.repo.owner}:${versionBranch}`,
        base: branch,
      })
    ).data;
  const held = (prs: Awaited<ReturnType<typeof listVersionPrs>>) => {
    const pr = prs.find((p) =>
      (p.labels ?? []).some((l) => l.name === holdLabel),
    );
    if (pr) {
      core.info(
        `The version PR #${pr.number} has the "${holdLabel}" label, so this run leaves its branch alone. Remove the label to let the action update it again.`,
      );
    }
    return pr;
  };
  const heldEarly = held(await listVersionPrs());
  if (heldEarly) {
    return { pullRequestNumber: heldEarly.number, skipped: "held" };
  }

  const pre = await readPreState(cwd);
  const preState = pre?.mode === "pre" ? pre : undefined;

  await github.prepareBranch(versionBranch);

  const packagesBefore = await listPackages(cwd);
  const versionsBefore = new Map(
    packagesBefore.map((p) => [`${p.ecosystem}:${p.dir}`, p.version]),
  );

  const env = { ...process.env, GITHUB_TOKEN: github.getToken() };

  if (script) {
    await exec(script, undefined, { cwd, env });
  } else {
    const args = ["version", "--yes"];
    for (const name of only ?? []) {
      args.push("--only", name);
    }
    // In a group's run, only that group's releaseAs entries apply.
    const groupReleaseAs =
      only && releaseAs
        ? Object.fromEntries(
            Object.entries(releaseAs).filter(([name]) => only.includes(name)),
          )
        : releaseAs;
    for (const spec of releaseAsArgs(
      groupReleaseAs,
      packagesBefore,
      preState,
      firstRelease,
    )) {
      args.push("--release-as", spec);
    }
    await execShiprig(args, { cwd, env });
  }

  // A first release stays at its version, and still releases.
  const firstHere = firstRelease.filter((name) => !only || only.includes(name));
  let changedPackages = (await listPackages(cwd)).filter(
    (p) =>
      versionsBefore.get(`${p.ecosystem}:${p.dir}`) !== p.version ||
      firstHere.includes(p.name),
  );
  // Only packages that had a version before: one without has nothing to
  // move from, and the summary would show a bump it can't know.
  const versions: VersionChange[] = changedPackages.flatMap((p) => {
    const from = versionsBefore.get(`${p.ecosystem}:${p.dir}`);
    return from === undefined ? [] : [{ name: p.name, from, to: p.version }];
  });

  // A title or message the user set keeps upstream's prerelease suffix. The
  // default names the versions instead, which already carry the tag
  // (1.2.0-beta.0), so it needs none.
  const preSuffix = preState ? ` (${preState.tag})` : "";
  const defaultTitle = releaseTitle(changedPackages);
  const finalPrTitle =
    prTitle !== undefined ? `${prTitle}${preSuffix}` : defaultTitle;
  const finalCommitMessage =
    commitMessage !== undefined ? `${commitMessage}${preSuffix}` : defaultTitle;

  // Awaited here, before the checks below, so nothing can change between
  // them and the push, and no early return leaves a read unhandled.
  const changedPackagesInfo = (
    await Promise.all(
      changedPackages.map(async (pkg) => {
        let entry = getChangelogEntry(
          (await readChangelog(pkg)) ?? "",
          pkg.version,
        );
        return {
          highestLevel: entry.highestLevel,
          private: pkg.private,
          content: entry.content,
          header: `## ${pkg.name}@${pkg.version}`,
        };
      }),
    )
  )
    .filter((x) => x)
    .sort(sortTheThings);

  // Listed again: the hold label may have been added, or another run may have
  // opened the PR, while the version script ran.
  const existingPullRequests = { data: await listVersionPrs() };
  const heldLate = held(existingPullRequests.data);
  if (heldLate) {
    return { pullRequestNumber: heldLate.number, skipped: "held" };
  }
  core.debug(
    `Existing pull requests: ${JSON.stringify(
      existingPullRequests.data,
      null,
      2,
    )}`,
  );

  if (await stale()) {
    return { skipped: "stale" };
  }

  await github.pushChanges({
    branch: versionBranch,
    message: finalCommitMessage,
  });

  let prBody = await getVersionPrBody({
    hasPublishScript,
    preState,
    branch,
    changedPackagesInfo,
    prBodyMaxCharacters,
  });

  if (existingPullRequests.data.length === 0) {
    core.info("Creating pull request");
    const { data: newPullRequest } = await octokit.rest.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: prBody,
      draft: prDraft !== undefined,
      ...context.repo,
    });

    return {
      pullRequestNumber: newPullRequest.number,
      versions,
    };
  } else {
    const [pullRequest] = existingPullRequests.data;

    core.info(`Updating found pull request #${pullRequest.number}`);
    const convertPullRequestToDraftMutation =
      prDraft === "always"
        ? `
        convertPullRequestToDraft(
          input: {
            pullRequestId: $pullRequestId
          }
        ) {
          pullRequest {
            id
          }
        }`
        : "";
    const updatePullRequestMutation = `
      mutation UpdatePullRequest(
        $pullRequestId: ID!
        $title: String!
        $body: String!
      ) {
        ${convertPullRequestToDraftMutation}

        updatePullRequest(
          input: {
            pullRequestId: $pullRequestId
            title: $title
            body: $body
            state: OPEN
          }
        ) {
          pullRequest {
            id
          }
        }
      }
    `;

    await octokit.graphql(updatePullRequestMutation, {
      pullRequestId: pullRequest.node_id,
      title: finalPrTitle,
      body: prBody,
    });

    return {
      pullRequestNumber: pullRequest.number,
      versions,
    };
  }
}

// The default version PR title and commit message: a conventional
// "chore: release" naming what the PR releases, as release-please's titles do.
//   one version for everything (a single package, or a fixed group):
//     chore: release 1.2.0
//   a few packages at different versions:
//     chore: release core@1.2.0, ui@0.5.0
//   more than that:
//     chore: release 5 packages
export function releaseTitle(
  packages: { name: string; version: string }[],
): string {
  const base = "chore: release";
  if (packages.length === 0) {
    return base;
  }
  const versions = new Set(packages.map((p) => p.version));
  if (versions.size === 1) {
    return `${base} ${packages[0].version}`;
  }
  if (packages.length > 3) {
    return `${base} ${packages.length} packages`;
  }
  // A short name two packages share (github.com/a/x/ui, github.com/b/y/ui)
  // would name neither, so those two keep their full names.
  const shortCount = new Map<string, number>();
  for (const p of packages) {
    const short = shortPackageName(p.name);
    shortCount.set(short, (shortCount.get(short) ?? 0) + 1);
  }
  const named = packages
    .map((p) => {
      const short = shortPackageName(p.name);
      return `${shortCount.get(short) === 1 ? short : p.name}@${p.version}`;
    })
    .sort();
  return `${base} ${named.join(", ")}`;
}

// A scoped npm name reads as itself; a path-like one (a Go module, a Maven
// group/artifact) by its last segment: github.com/acme/tool/ui -> ui.
function shortPackageName(name: string): string {
  if (name.startsWith("@")) {
    return name;
  }
  return name.slice(name.lastIndexOf("/") + 1);
}

// Whether the publish path runs, once no changesets are pending. With
// `version-pr-merge` a push publishes only when it's the version PR's merge,
// a run started by hand (workflow_dispatch) always does, for a first release
// or a retry, and any other event (a schedule, a pull request, workflow_run)
// never does. `every-push` is changesets/action's behaviour: publish whatever
// the event.
export async function publishDecision({
  github,
  publishOn,
  eventName,
  base,
}: {
  github: Pick<GitHub, "isVersionPrMerge">;
  publishOn: string;
  eventName: string;
  base: string;
}): Promise<{ publish: boolean; reason: string }> {
  if (publishOn !== "version-pr-merge" && publishOn !== "every-push") {
    throw new Error(
      `Invalid publish-on: ${publishOn} (expected "version-pr-merge" or "every-push")`,
    );
  }
  if (publishOn === "every-push" || eventName === "workflow_dispatch") {
    return {
      publish: true,
      reason:
        "No changesets found. Attempting to publish any unpublished packages",
    };
  }
  if (eventName !== "push") {
    return {
      publish: false,
      reason: `Nothing to publish: a ${eventName} run doesn't publish with publish-on: version-pr-merge; only the version PR's merge or a run started by hand does.`,
    };
  }
  const versionBranch = `changeset-release/${base}`;
  if (await github.isVersionPrMerge(versionBranch, base)) {
    return {
      publish: true,
      reason: `This push merges the version PR (${versionBranch}); publishing.`,
    };
  }
  return {
    publish: false,
    reason:
      `Nothing to publish: this push isn't the merge of the version PR (${versionBranch}). ` +
      "To publish on every push, set publish-on: every-push; a workflow_dispatch run, if the workflow allows one, always publishes.",
  };
}

/**
 * The `--release-as <package>=<version>` arguments for this version run:
 * each `releaseAs` entry that still applies. One for a package that isn't
 * releasing in this run, or that's already at or past the version, is
 * skipped with a note, so an entry left in the config after its release
 * doesn't fail every later push (release-please's release-as behaves the
 * same). A prerelease sets its own version suffix, so nothing applies then.
 */
export function releaseAsArgs(
  releaseAs: Record<string, string> | undefined,
  packages: ShiprigPackage[],
  preState: { tag: string } | undefined,
  // Packages releasing at their current, unreleased version (firstReleases).
  firstRelease: string[] = [],
): string[] {
  const entries = Object.entries(releaseAs ?? {});
  if (entries.length === 0) return [];
  // Every name is checked, prerelease or not: a typo shouldn't pass silently
  // for as long as a prerelease lasts and only fail at the stable release.
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const [name] of entries) {
    if (!byName.has(name)) {
      throw new Error(
        `releaseAs names ${name}, which isn't a package in this workspace.`,
      );
    }
  }
  if (preState) {
    core.info(
      `releaseAs waits for a normal release: this is a prerelease (${preState.tag}).`,
    );
    return [];
  }
  const args: string[] = [];
  for (const [name, version] of entries) {
    const pkg = byName.get(name)!;
    // At its own version and unreleased: a first release at that version,
    // which shiprig checks against the registry and the tags itself.
    if (firstRelease.includes(name)) {
      core.info(
        `releaseAs: ${name} is at ${version}, which isn't released yet; releasing it at that version.`,
      );
      args.push(`${name}=${version}`);
      continue;
    }
    // A full semver comparison: a target with a prerelease or build suffix
    // (2.0.0-rc.1, 2.0.0+build.5) is compared whole, so a package already
    // past it isn't handed an override for a version behind it. A current
    // version that isn't semver can't be compared, so the entry still goes to
    // shiprig, which says what's wrong with it.
    if (semver.valid(pkg.version) && semver.gte(pkg.version, version)) {
      core.info(
        `releaseAs: ${name} is already ${pkg.version}, at or past ${version}; nothing to do (remove the entry when you like).`,
      );
      continue;
    }
    const releasing =
      pkg.bump !== undefined &&
      pkg.bump !== "none" &&
      pkg.nextVersion !== undefined;
    if (!releasing) {
      core.info(
        `releaseAs: ${name} isn't releasing in this run; ${version} applies once a changeset or commit releases it.`,
      );
      continue;
    }
    args.push(`${name}=${version}`);
  }
  return args;
}
