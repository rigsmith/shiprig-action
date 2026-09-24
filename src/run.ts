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
import type { GitHub } from "./github.ts";
import type { Octokit } from "./octokit.ts";
import { commentReleasedPrs as commentReleasedPrsOn } from "./releasedComments.ts";
import {
  atLeast,
  execShiprig,
  getExecOutputShiprig,
  listPackages,
  readChangelog,
  readPreState,
  readReleasePlan,
  type ShiprigPackage,
} from "./shiprig.ts";
import { getChangelogEntry, sortTheThings } from "./utils.ts";

// GitHub Issues/PRs messages have a max size limit on the
// message body payload.
// `body is too long (maximum is 65536 characters)`.
// To avoid that, we ensure to cap the message to 60k chars.
const MAX_CHARACTERS_PER_MESSAGE = 60000;

const createRelease = async (
  octokit: Octokit,
  { pkg, tagName }: { pkg: ShiprigPackage; tagName: string },
) => {
  const changelog = await readChangelog(pkg);
  if (changelog === undefined) {
    // if we can't find a changelog, the user has probably disabled changelogs
    return;
  }
  let changelogEntry = getChangelogEntry(changelog, pkg.version);
  if (!changelogEntry) {
    // we can find a changelog but not the entry for this version
    // if this is true, something has probably gone wrong
    throw new Error(
      `Could not find changelog entry for ${pkg.name}@${pkg.version}`,
    );
  }

  await octokit.rest.repos.createRelease({
    name: tagName,
    tag_name: tagName,
    body: changelogEntry.content,
    prerelease: pkg.version.includes("-"),
    ...context.repo,
  });
};

type PublishOptions = {
  script?: string;
  fromPackDir?: string;
  createGithubReleases: boolean;
  pushGitTags: boolean;
  // Comment "released in" on the pull requests whose changesets shipped.
  commentReleasedPrs?: boolean;
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
  cwd,
}: PublishOptions): Promise<PublishResult> {
  const { octokit } = github;
  // Changesets creates annotated tags locally, including when the action pushes those tags through the GitHub API.
  // It might also be important for custom publish scripts to have a valid git user configured.
  await github.ensureGitUser();

  // Checked before publishing, which can't be undone: a package list that
  // fails validation stops the run while nothing has gone out yet, not after,
  // when the tags it published would be left unreported. It's read again once
  // the script has run (below), since a custom script may change versions.
  await listPackages(cwd);

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

  if (createGithubReleases || pushGitTags) {
    await Promise.all(
      releases.map(async ({ pkg, tag }) => {
        if (pushGitTags) {
          await github.pushTag(tag);
        }
        if (createGithubReleases) {
          await createRelease(octokit, { pkg, tagName: tag });
        }
      }),
    );
  }

  // Only once the tags are on GitHub: a comment links each release.
  if (commentReleasedPrs && pushGitTags && releases.length) {
    await commentReleasedPrsOn({
      octokit,
      sha: context.sha,
      released: await Promise.all(
        releases.map(async ({ pkg, tag }) => {
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
};

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
  const branch = options.branch ?? context.ref.replace("refs/heads/", "");
  const versionBranch = `changeset-release/${branch}`;
  if (!separatePullRequests) {
    const result = await runVersionBranch({
      ...options,
      branch,
      versionBranch,
    });
    return {
      ...result,
      pullRequestNumbers:
        result.pullRequestNumber === undefined
          ? []
          : [result.pullRequestNumber],
    };
  }
  if (script) {
    throw new Error(
      "separate-pull-requests can't be combined with a custom version-script: each PR versions one release group with `shiprig version --only`, which the script doesn't run.",
    );
  }
  return runVersionPerGroup({ ...options, branch, versionBranch });
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

  const branches = new Set<string>();
  const numbers: number[] = [];
  let ran = 0;
  let held = 0;
  let first = true;
  for (const group of [...groups.keys()].sort()) {
    const members = groups.get(group)!;
    // Nothing in the group actually releases (range-only rewrites alone).
    if (!plan.some((r) => members.includes(r.name) && r.type !== "none")) {
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
    )) {
      args.push("--release-as", spec);
    }
    await execShiprig(args, { cwd, env });
  }

  let changedPackages = (await listPackages(cwd)).filter(
    (p) => versionsBefore.get(`${p.ecosystem}:${p.dir}`) !== p.version,
  );

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
): string[] {
  const entries = Object.entries(releaseAs ?? {});
  if (entries.length === 0) return [];
  if (preState) {
    core.info(
      `releaseAs waits for a normal release: this is a prerelease (${preState.tag}).`,
    );
    return [];
  }
  const byName = new Map(packages.map((p) => [p.name, p]));
  const args: string[] = [];
  for (const [name, version] of entries) {
    const pkg = byName.get(name);
    if (!pkg) {
      throw new Error(
        `releaseAs names ${name}, which isn't a package in this workspace.`,
      );
    }
    if (atLeast(pkg.version, version)) {
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
