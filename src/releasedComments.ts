import * as core from "@actions/core";
import { context } from "@actions/github";

// "Released in" comments: after a release, each pull request whose changeset
// shipped gets one comment naming the package versions it went out in, as
// release-please and semantic-release do. The pull requests come from the
// changesets the version PR's merge consumed, so a monorepo PR is credited
// only for the packages its changeset named, as the changelog credits it.

export type ReleasedPackage = {
  name: string;
  version: string;
  tag: string;
  // This version's changelog section, for releases that consumed no
  // changesets (versioning.source: commits).
  notes?: string;
};

// The parts of Octokit this uses, so tests can stand one in.
export type CommentOctokit = {
  rest: {
    repos: {
      getCommit(p: {
        owner: string;
        repo: string;
        ref: string;
        per_page: number;
        page: number;
      }): Promise<{
        data: {
          sha?: string;
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
        page: number;
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
    // The commit's files come a page at a time; a release in a big monorepo
    // can remove more changesets than fit on one.
    let parent: string | undefined;
    const files: { filename: string; status?: string }[] = [];
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.repos.getCommit({
        ...repo,
        ref: sha,
        per_page: 100,
        page,
      });
      parent ??= data.parents[0]?.sha;
      files.push(...(data.files ?? []));
      if ((data.files ?? []).length < 100) break;
    }
    const consumed = files.filter(
      (f) =>
        f.status === "removed" &&
        CHANGESET.test(f.filename) &&
        f.filename.split("/").at(-1)?.toLowerCase() !== "readme.md",
    );
    // pull request -> the released packages it's credited for
    const credited = new Map<number, Set<ReleasedPackage>>();
    const credit = (pr: number, r: ReleasedPackage) => {
      const set = credited.get(pr) ?? new Set();
      set.add(r);
      credited.set(pr, set);
    };
    if (!parent || consumed.length === 0) {
      // A release from conventional commits consumes no changesets; its
      // pull requests are the ones its changelog sections reference.
      await creditFromNotes(octokit, released, credit);
      if (credited.size === 0) {
        core.info(
          "No changesets were consumed and the changelog references no pull requests or commits, so there are none to comment on.",
        );
        return [];
      }
    }
    for (const file of parent ? consumed : []) {
      // One changeset that can't be traced costs only its own attribution.
      try {
        const text = await readAt(octokit, file.filename, parent);
        const named = released.filter((r) => namesPackage(text, r.name));
        if (named.length === 0) continue;
        const pr = await pullRequestThatAdded(octokit, file.filename, parent!);
        if (pr === undefined) continue;
        for (const r of named) credit(pr, r);
      } catch (err) {
        core.warning(
          `Couldn't find the pull request that added ${file.filename}: ${(err as Error).message}`,
        );
      }
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
 * Whether a changeset's frontmatter names the package, as a package entry:
 * a quoted name at the start of a line (canon's `"pkg": minor`, shiprig's
 * `"pkg"`), or a bare `pkg: minor` whose value is a bump level. shiprig reads
 * bare `type:` and `scope:` as metadata whatever their value, so those two
 * never name a package unless quoted.
 */
export function namesPackage(changeset: string, name: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(changeset);
  if (!match) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = new RegExp(`^\\s*(["'])${escaped}\\1\\s*(:.*)?$`, "m");
  if (quoted.test(match[1])) return true;
  if (name === "type" || name === "scope") return false;
  const bare = new RegExp(
    `^\\s*${escaped}\\s*:\\s*(major|minor|patch|none)?\\s*$`,
    "m",
  );
  return bare.test(match[1]);
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
  // Newest first, a page at a time: the adding commit is the last one of all.
  let adding: string | undefined;
  for (let page = 1; ; page++) {
    const { data: commits } = await octokit.rest.repos.listCommits({
      ...context.repo,
      path,
      sha: ref,
      per_page: 100,
      page,
    });
    adding = commits.at(-1)?.sha ?? adding;
    if (commits.length < 100) break;
  }
  if (!adding) return undefined;
  const { data: pulls } =
    await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...context.repo,
      commit_sha: adding,
    });
  return pulls.find((p) => p.merged_at != null)?.number;
}

/**
 * The pull requests and commits a changelog section references:
 * changelog-github's `[#12](…/pull/12)` links and `` [`abc1234`](…) `` commits,
 * and changelog-git's `- abc1234: …` prefixes. Pull request links count only
 * for this repository.
 */
export function referencesIn(notes: string): {
  pullRequests: number[];
  commits: string[];
} {
  const { owner, repo } = context.repo;
  const escaped = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pullRequests = [
    ...notes.matchAll(new RegExp(`/${escaped}/pull/(\\d+)`, "g")),
  ].map((m) => Number(m[1]));
  const commits = [
    ...notes.matchAll(/\[`([0-9a-f]{7,40})`\]/g),
    ...notes.matchAll(/^\s*-\s+([0-9a-f]{7,40}):\s/gm),
  ].map((m) => m[1]);
  return {
    pullRequests: [...new Set(pullRequests)],
    commits: [...new Set(commits)],
  };
}

// Credits each released package's pull requests from its changelog section:
// the ones it links, and the merged pull requests of the commits it names.
// One reference that can't be looked up costs only itself. A commit named in
// several packages' sections is looked up once.
async function creditFromNotes(
  octokit: CommentOctokit,
  released: ReleasedPackage[],
  credit: (pr: number, r: ReleasedPackage) => void,
): Promise<void> {
  // Answers only: a lookup that failed is tried again for the next package.
  const prOfCommit = new Map<string, number | undefined>();
  const lookUp = async (
    commit: string,
  ): Promise<{ pr: number | undefined } | undefined> => {
    try {
      const { data: full } = await octokit.rest.repos.getCommit({
        ...context.repo,
        ref: commit,
        per_page: 1,
        page: 1,
      });
      const sha = full.sha ?? commit;
      const { data: pulls } =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          ...context.repo,
          commit_sha: sha,
        });
      return { pr: pulls.find((p) => p.merged_at != null)?.number };
    } catch (err) {
      core.warning(
        `Couldn't find the pull request for commit ${commit}: ${(err as Error).message}`,
      );
      return undefined;
    }
  };
  for (const r of released) {
    if (!r.notes) continue;
    const { pullRequests, commits } = referencesIn(r.notes);
    for (const pr of pullRequests) credit(pr, r);
    if (pullRequests.length > 0) continue; // the links already name them
    for (const commit of commits) {
      if (!prOfCommit.has(commit)) {
        const found = await lookUp(commit);
        if (found) prOfCommit.set(commit, found.pr);
      }
      const pr = prOfCommit.get(commit);
      if (pr !== undefined) credit(pr, r);
    }
  }
}
