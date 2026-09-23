import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "tinyexec";
import { stripJsonc } from "../config.ts";
import { getExecOutputShiprig, listPackages } from "../shiprig.ts";

// The shiprig side of pr-status: which changesets and packages a pull request
// touches, and the changelog its changesets would write. Every function here
// runs in pr-status's throwaway worktree of the pull request's head.

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    nodeOptions: { cwd },
    throwOnError: true,
  });
  return result.stdout;
}

// Paths from git, NUL-separated (-z), so a quoted or unusual name comes
// through as it is.
async function gitPaths(cwd: string, args: string[]): Promise<string[]> {
  return (await git(cwd, [...args, "-z"])).split("\0").filter(Boolean);
}

function isChangeset(file: string): boolean {
  return (
    /(^|\/)\.changeset\/[^/]+\.md$/.test(file) &&
    path.basename(file).toLowerCase() !== "readme.md"
  );
}

/**
 * The changeset files the pull request adds or edits (paths from the
 * repository root): the ones `shiprig status --since` plans for.
 */
export async function pullRequestChangesets(
  cwd: string,
  baseRef: string,
): Promise<string[]> {
  return (
    await gitPaths(cwd, [
      "diff",
      "--name-only",
      "--diff-filter=d",
      `${baseRef}...HEAD`,
    ])
  ).filter(isChangeset);
}

/**
 * The packages the pull request changes: each changed file belongs to the
 * deepest package directory that holds it, so a single-package repository's
 * root package takes everything and a monorepo's packages take their own.
 */
export async function changedPackages(
  cwd: string,
  baseRef: string,
): Promise<string[]> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const files = (
    await gitPaths(cwd, ["diff", "--name-only", `${baseRef}...HEAD`])
  ).filter((f) => !isChangeset(f));
  const packages = (await listPackages(cwd))
    .filter((p) => !p.ignored)
    .map((p) => ({
      name: p.name,
      // git's separator, whatever the platform's
      dir: path.relative(root, p.dir).split(path.sep).join("/"),
    }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const changed = new Set<string>();
  for (const file of files) {
    const owner = packages.find(
      (p) => p.dir === "" || file === p.dir || file.startsWith(`${p.dir}/`),
    );
    if (owner) changed.add(owner.name);
  }
  return [...changed].sort();
}

/**
 * The changelog the pull request's own changesets would write, as Markdown for
 * a comment, or undefined when it can't be shown. Other pending changesets are
 * removed from the worktree first, so only this pull request's entries show;
 * the worktree is thrown away afterwards.
 *
 * Only for a repository that versions from changesets alone
 * (versionsFromChangesetsOnly): with commits as a source, it would add
 * entries for commits already on the base branch, and shiprig can't limit
 * those to the pull request's range.
 */
export async function previewChangelog(
  cwd: string,
  own: string[],
): Promise<string | undefined> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const keep = new Set(own);
  const tracked = (await gitPaths(cwd, ["ls-files"])).filter(isChangeset);
  for (const file of tracked) {
    if (!keep.has(file)) await fs.rm(path.join(root, file), { force: true });
  }
  const out = await getExecOutputShiprig(["version", "--changelog"], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  });
  if (out.exitCode !== 0) return undefined;
  return changelogMarkdown(out.stdout);
}

/**
 * Whether the changeset config leaves `versioning.source` at changesets, read
 * through `shiprig config show` (the file shiprig resolved, as written). No
 * config is the default, changesets; one that can't be read counts as not.
 */
export async function versionsFromChangesetsOnly(
  cwd: string,
): Promise<boolean> {
  const out = await getExecOutputShiprig(["config", "show"], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  });
  if (out.exitCode !== 0) return false;
  const text = out.stdout.trim();
  if (text.startsWith("no config yet")) return true;
  try {
    const source = JSON.parse(stripJsonc(text))?.versioning?.source;
    return source === undefined || source === "changesets";
  } catch {
    return false;
  }
}

/**
 * The Markdown part of `shiprig version --changelog`'s output (the plan lines
 * before it and the dry-run note after it dropped), its headings moved down
 * two levels to sit inside a comment.
 */
export function changelogMarkdown(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => /^# /.test(l));
  if (start < 0) return undefined;
  const body = lines
    .slice(start)
    .filter((l) => !/^\(dry run/.test(l.trim()))
    .map((l) => (/^#{1,4} /.test(l) ? `##${l}` : l))
    .join("\n")
    .trim();
  return body || undefined;
}
