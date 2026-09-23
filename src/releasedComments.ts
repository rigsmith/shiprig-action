import * as core from "@actions/core";
import { context } from "@actions/github";

// "Released in" comments: after a release, each pull request whose changeset
// shipped gets one comment naming the package versions it went out in, as
// release-please and semantic-release do. The pull requests come from the
// changesets the version PR's merge consumed, so a monorepo PR is credited
// only for the packages its changeset named, as the changelog credits it.

export type ReleasedPackage = { name: string; version: string; tag: string };

// The parts of Octokit this uses, so tests can stand one in.
export type CommentOctokit = {
  rest: {
    repos: {
      getCommit(p: { owner: string; repo: string; ref: string }): Promise<{
        data: {
          parents: { sha: string }[];
          files?: { filename: string; status?: string }[];
        };
      }>;
      getContent(p: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
      listCommits(p: {
        owner: string;
        repo: string;
        path: string;
        sha: string;
        per_page: number;
      }): Promise<{ data: { sha: string }[] }>;
      listPullRequestsAssociatedWithCommit(p: {
        owner: string;
        repo: string;
        commit_sha: string;
      }): Promise<{ data: { number: number; merged_at: string | null }[] }>;
    };
    issues: {
      listComments(p: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: { body?: string | null }[] }>;
      createComment(p: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
    };
  };
};

const CHANGESET = /(^|\/)\.changeset\/[^/]+\.md$/;

/**
 * Comments on each pull request whose changeset the release at `sha` (the
 * version PR's merge) consumed. Returns the pull requests commented on. Never
 * throws: the release has already gone out, so a failure here is a warning.
 */
export async function commentReleasedPrs({
  octokit,
  sha,
  released,
  serverUrl,
}: {
  octokit: CommentOctokit;
  sha: string;
  released: ReleasedPackage[];
  serverUrl: string;
}): Promise<number[]> {
  const repo = context.repo;
  try {
    const { data: commit } = await octokit.rest.repos.getCommit({
      ...repo,
      ref: sha,
    });
    const parent = commit.parents[0]?.sha;
    const consumed = (commit.files ?? []).filter(
      (f) =>
        f.status === "removed" &&
        CHANGESET.test(f.filename) &&
        f.filename.split("/").at(-1)?.toLowerCase() !== "readme.md",
    );
    if (!parent || consumed.length === 0) {
      core.info(
        "No changesets were consumed by this commit, so there are no pull requests to comment on.",
      );
      return [];
    }

    // pull request -> the released packages its changesets named
    const credited = new Map<number, Set<ReleasedPackage>>();
    for (const file of consumed) {
      const text = await readAt(octokit, file.filename, parent);
      const named = released.filter((r) => namesPackage(text, r.name));
      if (named.length === 0) continue;
      const pr = await pullRequestThatAdded(octokit, file.filename, parent);
      if (pr === undefined) continue;
      const set = credited.get(pr) ?? new Set();
      for (const r of named) set.add(r);
      credited.set(pr, set);
    }

    const marker = `<!-- shiprig-action:released ${sha} -->`;
    const commented: number[] = [];
    for (const [pr, packages] of [...credited].sort((a, b) => a[0] - b[0])) {
      try {
        if (await hasComment(octokit, pr, marker)) continue;
        await octokit.rest.issues.createComment({
          ...repo,
          issue_number: pr,
          body: commentBody([...packages], serverUrl, marker),
        });
        commented.push(pr);
      } catch (err) {
        core.warning(
          `Couldn't comment on #${pr} that it was released: ${(err as Error).message}`,
        );
      }
    }
    if (commented.length > 0) {
      core.info(
        `Commented "released in" on ${commented.map((n) => `#${n}`).join(", ")}.`,
      );
    }
    return commented;
  } catch (err) {
    core.warning(
      `Couldn't comment on the released pull requests: ${(err as Error).message}`,
    );
    return [];
  }
}

export function commentBody(
  packages: ReleasedPackage[],
  serverUrl: string,
  marker: string,
): string {
  const { owner, repo } = context.repo;
  const lines = [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (p) =>
        `- [\`${p.name}@${p.version}\`](${serverUrl}/${owner}/${repo}/releases/tag/${encodeURI(p.tag)})`,
    );
  return [
    "🚀 Released in:",
    "",
    ...lines,
    "",
    "<sub>Posted by shiprig-action.</sub>",
    marker,
  ].join("\n");
}

/**
 * Whether a changeset's frontmatter names the package, as a key: canon's
 * `"pkg": minor`, shiprig's `"pkg"` line, or a bare `pkg: minor`. Only a name
 * at the start of a line counts, so shiprig's `scope: pkg` names nothing.
 */
export function namesPackage(changeset: string, name: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(changeset);
  if (!match) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(["']?)${escaped}\\1\\s*(:|$)`, "m").test(match[1]);
}

// Whether any comment on the pull request carries the marker, on any page: a
// busy pull request can have more than one page of comments before this one.
async function hasComment(
  octokit: CommentOctokit,
  pr: number,
  marker: string,
): Promise<boolean> {
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listComments({
      ...context.repo,
      issue_number: pr,
      per_page: 100,
      page,
    });
    if (data.some((c) => c.body?.includes(marker))) return true;
    if (data.length < 100) return false;
  }
}

async function readAt(
  octokit: CommentOctokit,
  path: string,
  ref: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.getContent({
    ...context.repo,
    path,
    ref,
  });
  const content = (data as { content?: string }).content;
  return content ? Buffer.from(content, "base64").toString("utf8") : "";
}

// The merged pull request that added `path`: the oldest commit touching it up
// to `ref`, and the pull request GitHub associates with that commit.
async function pullRequestThatAdded(
  octokit: CommentOctokit,
  path: string,
  ref: string,
): Promise<number | undefined> {
  const { data: commits } = await octokit.rest.repos.listCommits({
    ...context.repo,
    path,
    sha: ref,
    per_page: 100,
  });
  const adding = commits.at(-1)?.sha;
  if (!adding) return undefined;
  const { data: pulls } =
    await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...context.repo,
      commit_sha: adding,
    });
  return pulls.find((p) => p.merged_at != null)?.number;
}
