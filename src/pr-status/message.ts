import * as github from "@actions/github";
import { markdownTable } from "markdown-table";
import { type PlannedRelease, readReleasePlan } from "../shiprig.ts";
import {
  previewChangelog,
  pullRequestChangesets,
  versionsFromChangesetsOnly,
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
  const changesetsOnly = await versionsFromChangesetsOnly(cwd);
  if (own.length === 0 && changesetsOnly) {
    return getAbsentMessage(pr.sha, newChangesetUrl);
  }

  // `--since` scopes both to the pull request: its changesets and, with
  // commits as a source, its commits.
  const releases = await readReleasePlan(cwd, { since: baseRef });
  if (own.length === 0 && !releases.some((r) => r.type !== "none")) {
    return getAbsentMessage(pr.sha, newChangesetUrl);
  }
  const preview = await previewChangelog(cwd, baseRef);
  return getApproveMessage(
    pr.sha,
    newChangesetUrl,
    releases,
    own.length,
    preview,
  );
}

export function getApproveMessage(
  commitSha: string,
  newChangesetUrl: string,
  releases: PlannedRelease[],
  changesets: number,
  preview: string | undefined,
) {
  // A repository versioning from commits can release with no changeset.
  const title = changesets > 0 ? "Changeset detected" : "Release detected";
  return `\
### 🦋 ${title}

Latest commit: ${commitSha}

**The changes in this PR will be included in the next version bump.**

${getReleasePlanMessage(releases, changesets)}
${getPreviewMessage(preview)}
Not sure what this means? [Click here to learn what changesets are](https://changesets.dev/faq).

[Click here if you're a maintainer who wants to add another changeset to this PR](${newChangesetUrl})`;
}

export function getAbsentMessage(commitSha: string, newChangesetUrl: string) {
  return `\
### ⚠️ No Changeset found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

${getReleasePlanMessage([], 0)}

[Click here to learn what changesets are, and how to add one](https://changesets.dev/faq).

[Click here if you're a maintainer who wants to add a changeset to this PR](${newChangesetUrl})`;
}

function getPreviewMessage(preview: string | undefined): string {
  if (!preview) return "";
  return `\
<details>
<summary>Changelog preview</summary>

What this PR's changesets add to the changelogs:

${preview}

</details>
`;
}

function getReleasePlanMessage(releases: PlannedRelease[], changesets: number) {
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

  let summary = "This PR includes ";
  if (changesets === 0 && bumps.length > 0) {
    // Released from its commits, with no changeset.
    summary = `This PR's commits release ${bumps.length} package${bumps.length === 1 ? "" : "s"}`;
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
