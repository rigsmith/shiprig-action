import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "tinyexec";
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
  const out = await git(cwd, [
    "diff",
    "--name-only",
    "--diff-filter=d",
    `${baseRef}...HEAD`,
  ]);
  return out.split("\n").filter(Boolean).filter(isChangeset);
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
  const files = (await git(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]))
    .split("\n")
    .filter(Boolean)
    .filter((f) => !isChangeset(f));
  const packages = (await listPackages(cwd))
    .filter((p) => !p.ignored)
    .map((p) => ({
      name: p.name,
      dir: path.relative(root, p.dir),
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
 * a comment, or undefined when shiprig can't render it. Other pending
 * changesets are removed from the worktree first, so only this pull request's
 * entries show; the worktree is thrown away afterwards.
 */
export async function previewChangelog(
  cwd: string,
  own: string[],
): Promise<string | undefined> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const keep = new Set(own);
  const tracked = (await git(cwd, ["ls-files"]))
    .split("\n")
    .filter(Boolean)
    .filter(isChangeset);
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
