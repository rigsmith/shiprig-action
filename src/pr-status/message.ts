import * as github from "@actions/github";
import { markdownTable } from "markdown-table";
import { type PlannedRelease, readReleasePlan } from "../shiprig.ts";
import {
  changedPackages,
  previewChangelog,
  pullRequestChangesets,
  unreleasedPackages,
  type VersioningSource,
  versioningSource,
} from "./preview.ts";
import {
  getNewChangesetTemplateContent,
  getNewChangesetUrl,
} from "./template.ts";
import { getPullRequestWorktree } from "./worktree.ts";

type PullRequestContext = NonNullable<
  typeof github.context.payload.pull_request
>;

export async function getCommentMessage(context: PullRequestContext) {
  await using worktree = await getPullRequestWorktree(context);
  return getStatus(worktree.cwd, worktree.baseRef, {
    sha: context.head.sha,
    title: context.title,
    headRepoUrl: context.head.repo.html_url,
    headRef: context.head.ref,
  });
}

type PullRequestInfo = {
  sha: string;
  title: string;
  headRepoUrl: string;
  headRef: string;
};

/** The comment for a checkout of the pull request's head, compared to baseRef. */
export async function getStatusMessage(
  cwd: string,
  baseRef: string,
  pr: PullRequestInfo,
) {
  return (await getStatus(cwd, baseRef, pr)).body;
}

/**
 * The comment, and the packages the pull request changes that nothing in it
 * releases (see unreleasedPackages): the action warns about those, and never
 * fails over them.
 */
export async function getStatus(
  cwd: string,
  baseRef: string,
  pr: PullRequestInfo,
): Promise<{ body: string; unreleased: string[] }> {
  const own = await pullRequestChangesets(cwd, baseRef);
  const changed = await changedPackages(cwd, baseRef);
  const templateContent = getNewChangesetTemplateContent(changed, pr.title);
  const newChangesetUrl = getNewChangesetUrl(
    pr.headRepoUrl,
    pr.headRef,
    templateContent,
  );

  // In a changesets-only repository, a pull request with no changeset of its
  // own has nothing to plan, and `status --since` (the CI gate there) fails
  // when packages changed with none.
  const source = await versioningSource(cwd);
  if (source === "changesets" && own.length === 0) {
    const unreleased = await unreleasedPackages(cwd, changed, [], own);
    return {
      body: getAbsentMessage(pr.sha, newChangesetUrl, source, unreleased),
      unreleased,
    };
  }

  // `--since` scopes both to the pull request: its changesets and, with
  // commits as a source, its commits.
  const releases = await readReleasePlan(cwd, { since: baseRef });
  const releasing = releases.some((r) => r.type !== "none");
  const unreleased = await unreleasedPackages(
    cwd,
    changed,
    releases.filter((r) => r.type !== "none").map((r) => r.name),
    // With commits alone as the source, a changeset decides nothing.
    source === "commits" ? [] : own,
  );
  // With commits alone as the source, a changeset carries no release intent:
  // only the plan decides. Otherwise the PR's own changesets count too, an
  // empty one included, as canon counts them.
  if (!releasing && (source === "commits" || own.length === 0)) {
    return {
      body: getAbsentMessage(pr.sha, newChangesetUrl, source, unreleased),
      unreleased,
    };
  }
  const preview = await previewChangelog(cwd, baseRef);
  return {
    body: getApproveMessage(
      pr.sha,
      newChangesetUrl,
      releases,
      source === "commits" ? 0 : own.length,
      preview,
      source,
      unreleased,
    ),
    unreleased,
  };
}

export function getApproveMessage(
  commitSha: string,
  newChangesetUrl: string,
  releases: PlannedRelease[],
  changesets: number,
  preview: string | undefined,
  source: VersioningSource = "changesets",
  unreleased: string[] = [],
) {
  // A repository versioning from commits can release with no changeset.
  const title = changesets > 0 ? "Changeset detected" : "Release detected";
  const footer =
    source === "commits"
      ? "Releases here come from the PR's conventional commits (`feat:`, `fix:`, `!` for breaking)."
      : `Not sure what this means? [Click here to learn what changesets are](https://changesets.dev/faq).

[Click here if you're a maintainer who wants to add another changeset to this PR](${newChangesetUrl})`;
  return `\
### 🦋 ${title}

Latest commit: ${commitSha}

**The changes in this PR will be included in the next version bump.**
${getUnreleasedMessage(unreleased, source)}
${getReleasePlanMessage(releases, changesets, source)}
${getPreviewMessage(preview)}
${footer}`;
}

export function getAbsentMessage(
  commitSha: string,
  newChangesetUrl: string,
  source: VersioningSource = "changesets",
  unreleased: string[] = [],
) {
  if (source === "commits") {
    return `\
### ⚠️ No release found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **Releases here come from conventional commits: if these changes should result in a version bump, give a commit a releasing type** (\`feat:\`, \`fix:\`, \`!\` for breaking).
${getUnreleasedMessage(unreleased, source)}`;
  }
  const how =
    source === "both"
      ? "you need to add a changeset, or give a commit a releasing conventional type (`feat:`, `fix:`, `!` for breaking)"
      : "you need to add a changeset";
  return `\
### ⚠️ No Changeset found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, ${how}.**
${getUnreleasedMessage(unreleased, source)}
${getReleasePlanMessage([], 0, source)}

[Click here to learn what changesets are, and how to add one](https://changesets.dev/faq).

[Click here if you're a maintainer who wants to add a changeset to this PR](${newChangesetUrl})`;
}

/** The warning for changed packages nothing releases: empty when there are none. */
export function getUnreleasedMessage(
  unreleased: string[],
  source: VersioningSource,
): string {
  if (unreleased.length === 0) return "";
  const how =
    source === "commits"
      ? "give a commit a releasing conventional type (`feat:`, `fix:`, `!` for breaking)"
      : source === "both"
        ? "add a changeset for them, or give a commit a releasing conventional type (`feat:`, `fix:`, `!` for breaking)"
        : "add a changeset for them (`none` if they shouldn't release)";
  const names = unreleased.map((n) => `\`${n}\``).join(", ");
  return `
> [!WARNING]
> **Changed but not released:** ${names}. This PR changes ${unreleased.length === 1 ? "this package" : "these packages"}, and nothing in it releases ${unreleased.length === 1 ? "it" : "them"}. If that's intended, you're good to go; otherwise ${how}.
`;
}

function getPreviewMessage(preview: string | undefined): string {
  if (!preview) return "";
  return `\
<details>
<summary>Changelog preview</summary>

What this PR adds to the changelogs:

${preview}

</details>
`;
}

function getReleasePlanMessage(
  releases: PlannedRelease[],
  changesets: number,
  source: VersioningSource,
) {
  const bumps = releases.filter((r) => r.type !== "none");
  const table = markdownTable([
    ["Name", "Type", "Version"],
    ...bumps.map((r) => [
      r.name,
      (
        { major: "Major", minor: "Minor", patch: "Patch" } as Record<
          string,
          string
        >
      )[r.type] ?? r.type,
      r.newVersion,
    ]),
  ]);

  const packages = `${bumps.length} package${bumps.length === 1 ? "" : "s"}`;
  let summary = "This PR includes ";
  if (source === "both" && bumps.length > 0) {
    // Changesets and commits can both release here; don't credit either.
    summary = `This PR releases ${packages}`;
  } else if (changesets === 0 && bumps.length > 0) {
    // Released from its commits, with no changeset.
    summary = `This PR's commits release ${packages}`;
  } else if (changesets === 0) {
    summary += "no changesets";
  } else {
    summary += `changesets to release ${bumps.length} package`;
    if (bumps.length !== 1) {
      summary += "s";
    }
  }

  return `\
<details>
<summary>${summary}</summary>

${
  bumps.length > 0
    ? table
    : "When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types"
}

</details>`;
}
