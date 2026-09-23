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
import {
  execShiprig,
  getExecOutputShiprig,
  listPackages,
  readChangelog,
  readPreState,
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
    if (fromPackDir) {
      // `changeset publish --from-pack-dir` has no shiprig equivalent yet
      // (the split pack/publish sub-actions are phase 4 in docs/DESIGN.md).
      throw new Error(
        "Publishing from a pack directory isn't supported by shiprig-action yet.",
      );
    }
    changesetPublishOutput = await getExecOutputShiprig(
      ["publish", "--yes"],
      execOptions,
    );
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

  if (releases.length) {
    return {
      published: true,
      publishedPackages: releases.map(({ pkg }) => ({
        name: pkg.name,
        version: pkg.version,
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
};

type RunVersionResult = {
  // Undefined when the run was stale and left the version PR alone.
  pullRequestNumber?: number;
};

export async function runVersion({
  script,
  github,
  cwd = process.cwd(),
  prTitle,
  commitMessage,
  hasPublishScript = false,
  prBodyMaxCharacters = MAX_CHARACTERS_PER_MESSAGE,
  branch = context.ref.replace("refs/heads/", ""),
  prDraft,
}: VersionOptions): Promise<RunVersionResult> {
  const { octokit } = github;
  let versionBranch = `changeset-release/${branch}`;

  // Release workflows queue their runs (queue: max) rather than drop them, and
  // GitHub doesn't guarantee the order they start in. A run that starts after
  // a newer one would reset the version branch to its older commit, or reopen
  // a version PR that was just merged. If the base has moved past this run's
  // commit, the newer run owns the version PR, so this one leaves it alone.
  const newerHead = await github.baseMovedPast(branch, context.sha);
  if (newerHead !== undefined) {
    core.info(
      `${branch} has moved on to ${newerHead.slice(0, 7)} since this run's commit ` +
        `(${context.sha.slice(0, 7)}); the run for that commit updates the version PR, so this one leaves it alone.`,
    );
    return {};
  }

  const pre = await readPreState(cwd);
  const preState = pre?.mode === "pre" ? pre : undefined;

  await github.prepareBranch(versionBranch);

  const versionsBefore = new Map(
    (await listPackages(cwd)).map((p) => [
      `${p.ecosystem}:${p.dir}`,
      p.version,
    ]),
  );

  const env = { ...process.env, GITHUB_TOKEN: github.getToken() };

  if (script) {
    await exec(script, undefined, { cwd, env });
  } else {
    await execShiprig(["version", "--yes"], { cwd, env });
  }

  let changedPackages = (await listPackages(cwd)).filter(
    (p) => versionsBefore.get(`${p.ecosystem}:${p.dir}`) !== p.version,
  );
  let changedPackagesInfoPromises = Promise.all(
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

  const existingPullRequests = await octokit.rest.pulls.list({
    ...context.repo,
    state: "open",
    head: `${context.repo.owner}:${versionBranch}`,
    base: branch,
  });
  core.debug(
    `Existing pull requests: ${JSON.stringify(
      existingPullRequests.data,
      null,
      2,
    )}`,
  );

  await github.pushChanges({
    branch: versionBranch,
    message: finalCommitMessage,
  });

  const changedPackagesInfo = (await changedPackagesInfoPromises)
    .filter((x) => x)
    .sort(sortTheThings);

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
