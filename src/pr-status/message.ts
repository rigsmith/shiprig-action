import * as github from "@actions/github";
import { markdownTable } from "markdown-table";
import { type PlannedRelease, readReleasePlan } from "../shiprig.ts";
import {
  previewChangelog,
  pullRequestChangesets,
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
  return getStatusMessage(worktree.cwd, worktree.baseRef, {
    sha: context.head.sha,
    title: context.title,
    headRepoUrl: context.head.repo.html_url,
    headRef: context.head.ref,
  });
}

/** The comment for a checkout of the pull request's head, compared to baseRef. */
export async function getStatusMessage(
  cwd: string,
  baseRef: string,
  pr: { sha: string; title: string; headRepoUrl: string; headRef: string },
) {
  const own = await pullRequestChangesets(cwd, baseRef);
  const templateContent = await getNewChangesetTemplateContent(
    cwd,
    baseRef,
    pr.title,
  );
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
    return getAbsentMessage(pr.sha, newChangesetUrl, source);
  }

  // `--since` scopes both to the pull request: its changesets and, with
  // commits as a source, its commits.
  const releases = await readReleasePlan(cwd, { since: baseRef });
  const releasing = releases.some((r) => r.type !== "none");
  // With commits alone as the source, a changeset carries no release intent:
  // only the plan decides. Otherwise the PR's own changesets count too, an
  // empty one included, as canon counts them.
  if (!releasing && (source === "commits" || own.length === 0)) {
    return getAbsentMessage(pr.sha, newChangesetUrl, source);
  }
  const preview = await previewChangelog(cwd, baseRef);
  return getApproveMessage(
    pr.sha,
    newChangesetUrl,
    releases,
    source === "commits" ? 0 : own.length,
    preview,
    source,
  );
}

export function getApproveMessage(
  commitSha: string,
  newChangesetUrl: string,
  releases: PlannedRelease[],
  changesets: number,
  preview: string | undefined,
  source: VersioningSource = "changesets",
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

${getReleasePlanMessage(releases, changesets, source)}
${getPreviewMessage(preview)}
${footer}`;
}

export function getAbsentMessage(
  commitSha: string,
  newChangesetUrl: string,
  source: VersioningSource = "changesets",
) {
  if (source === "commits") {
    return `\
### ⚠️ No release found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **Releases here come from conventional commits: if these changes should result in a version bump, give a commit a releasing type** (\`feat:\`, \`fix:\`, \`!\` for breaking).`;
  }
  const how =
    source === "both"
      ? "you need to add a changeset, or give a commit a releasing conventional type (`feat:`, `fix:`, `!` for breaking)"
      : "you need to add a changeset";
  return `\
### ⚠️ No Changeset found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, ${how}.**

${getReleasePlanMessage([], 0, source)}

[Click here to learn what changesets are, and how to add one](https://changesets.dev/faq).

[Click here if you're a maintainer who wants to add a changeset to this PR](${newChangesetUrl})`;
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
