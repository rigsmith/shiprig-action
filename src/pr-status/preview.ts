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
 * The changelog entries the pull request adds, as Markdown for a comment, or
 * undefined when shiprig can't render them. `shiprig version --changelog
 * --since <base>` renders only the branch's share: its changesets and, with
 * commits as a versioning source, its commits. It writes nothing.
 */
export async function previewChangelog(
  cwd: string,
  baseRef: string,
): Promise<string | undefined> {
  const out = await getExecOutputShiprig(
    ["version", "--changelog", "--since", baseRef],
    { cwd, ignoreReturnCode: true, silent: true },
  );
  if (out.exitCode !== 0) return undefined;
  return changelogMarkdown(out.stdout);
}

/** Where a repository's releases come from: `versioning.source`. */
export type VersioningSource = "changesets" | "commits" | "both";

/**
 * The repository's versioning source, as `shiprig config show --json`
 * reports it (the config shiprig resolved, defaults applied, so
 * `versioning.source` is always there). One that can't be read counts as
 * "both", the source whose comment asks the plan either way.
 */
export async function versioningSource(cwd: string): Promise<VersioningSource> {
  const out = await getExecOutputShiprig(["config", "show", "--json"], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  });
  if (out.exitCode !== 0) return "both";
  try {
    const source = JSON.parse(out.stdout)?.versioning?.source;
    return source === "changesets" || source === "commits" ? source : "both";
  } catch {
    return "both";
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

/**
 * The packages a changeset's header names, whatever their bump, `none`
 * included: a package the pull request names is one its author decided about.
 * `shiprig status --output` leaves `none` out of the plan, so the header is
 * read here. A name this misreads only adds or drops a warning; it never
 * changes a release.
 */
export function changesetPackageNames(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  const names: string[] = [];
  for (const raw of lines.slice(1)) {
    if (raw.trim() === "---") return names;
    const name = releaseLineName(raw.trim());
    if (name !== undefined) names.push(name);
  }
  // No closing line: not a changeset header.
  return [];
}

// What may follow a key's colon: whitespace, the end, or nothing else.
const afterColon = /^\s*:(?:\s|$)/;

/**
 * The package a frontmatter line names, or undefined for anything else (a
 * comment, `type:`, a line this can't read). The key is read before any
 * comment is looked for, so a `#` inside a quoted name stays part of it.
 */
function releaseLineName(line: string): string | undefined {
  if (line === "" || line.startsWith("#")) return undefined;
  if (line.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(line);
    if (!m || !afterColon.test(line.slice(m[0].length))) return undefined;
    return yamlDoubleQuoted(m[1]);
  }
  if (line.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(line);
    if (!m || !afterColon.test(line.slice(m[0].length))) return undefined;
    return m[1].replaceAll("''", "'");
  }
  // A plain key ends where a comment starts (a `#` after whitespace), so
  // `a # note: x` names nothing rather than "a # note".
  const m = /^([^\s"'#][^:]*?)\s*:(?:\s|$)/.exec(line.replace(/\s#.*$/, ""));
  return m?.[1];
}

const yamlEscapes: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

/**
 * A YAML double-quoted scalar's text, escapes decoded (YAML's set, which is
 * JSON's plus `\x`, `\U`, `\_` and a few more), or undefined for an escape YAML
 * doesn't have. Never throws: a changeset this can't read only costs a warning.
 */
function yamlDoubleQuoted(body: string): string | undefined {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    const hex = { x: 2, u: 4, U: 8 }[e as "x" | "u" | "U"];
    if (hex) {
      const digits = body.slice(i + 1, i + 1 + hex);
      if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex)
        return undefined;
      const cp = Number.parseInt(digits, 16);
      if (cp > 0x10ffff) return undefined;
      out += String.fromCodePoint(cp);
      i += hex;
      continue;
    }
    if (!(e in yamlEscapes)) return undefined;
    out += yamlEscapes[e];
  }
  return out;
}

/**
 * The packages the pull request changes that nothing in it releases: not in
 * the plan (a changeset's bump, a releasing commit, or a dependent's cascade)
 * and not named by one of its own changesets, `none` included.
 */
export async function unreleasedPackages(
  cwd: string,
  changed: string[],
  released: string[],
  ownChangesets: string[],
): Promise<string[]> {
  const root = await fs.realpath(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const decided = new Set(released);
  for (const file of ownChangesets) {
    const content = await readInside(root, file);
    if (content === undefined) continue;
    for (const name of changesetPackageNames(content)) decided.add(name);
  }
  return changed.filter((name) => !decided.has(name));
}

/**
 * A changeset file's text, when it is a regular file inside root. The pull
 * request controls the checkout, so a symlink out of it (to a runner's own
 * files, say) is skipped rather than followed.
 */
async function readInside(
  root: string,
  file: string,
): Promise<string | undefined> {
  const full = path.join(root, file);
  const stat = await fs.lstat(full).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const real = await fs.realpath(full);
  if (!real.startsWith(root + path.sep)) return undefined;
  return fs.readFile(real, "utf8");
}
