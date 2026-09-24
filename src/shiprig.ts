// Everything shiprig-specific lives here: the rest of the action is upstream
// changesets/action, and keeping the seams in one module keeps the diff
// against it small enough to go on merging upstream fixes (docs/DESIGN.md).
//
// Each function stands in for an npm-only upstream dependency:
//   listPackages     → @manypkg/get-packages   (`shiprig packages list --json`)
//   readReleasePlan  → @changesets/read + assembleReleasePlan (`shiprig status --output`)
//   readPreState     → @changesets/pre         (.changeset/pre.json)
//   execShiprig      → execChangesetsCli       (`shiprig <verb>`)

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as core from "@actions/core";
import {
  exec,
  getExecOutput,
  type ExecOptions as ActionsExecOptions,
  type ExecOutput,
} from "@actions/exec";

const execFileAsync = promisify(execFile);

/**
 * The first shiprig release with every contract this action relies on: the
 * split publish flow (publish-plan, pack, publish --from-pack-dir), the
 * branch-scoped `--since` previews pr-status uses, and a `--version` a script
 * can read.
 */
export const MIN_SHIPRIG_VERSION = "1.21.0";

/** The shiprig binary: $SHIPRIG_BIN when set, else `shiprig` on PATH. */
export function shiprigBin(): string {
  return process.env.SHIPRIG_BIN || "shiprig";
}

interface ExecOptions extends Omit<ActionsExecOptions, "env"> {
  env?: Record<string, string | undefined>;
}

export function execShiprig(args: string[], options?: ExecOptions) {
  return exec(shiprigBin(), args, options as ActionsExecOptions);
}

export function getExecOutputShiprig(
  args: string[],
  options?: ExecOptions,
): Promise<ExecOutput> {
  return getExecOutput(shiprigBin(), args, options as ActionsExecOptions);
}

/** One package as `shiprig packages list --json` reports it, paths made absolute. */
export type ShiprigPackage = {
  name: string;
  ecosystem: string;
  /** Absolute package directory. */
  dir: string;
  version: string;
  nextVersion?: string;
  bump?: string;
  private: boolean;
  ignored: boolean;
  /** Absolute path of the CHANGELOG.md its notes go to. */
  changelog: string;
  /** Set when the changelog is shared (a stackspace root): the section title. */
  changelogSection?: string;
};

type PackagesJson = {
  packages: (Omit<ShiprigPackage, "dir" | "changelog"> & {
    dir: string;
    changelog: string;
  })[];
};

let checked: Promise<void> | undefined;

/** How long `shiprig --version` gets before the check gives up on it; a
 * test shortens it. */
export const versionCheck = { timeoutMs: 30_000 };

/**
 * Fails unless shiprig is MIN_SHIPRIG_VERSION or later, once per run.
 * `shiprig --version` prints the bare version when piped (1.21.0 on); an
 * older shiprig prints its banner there, which reads as too old. A source
 * build has no version and passes with a warning, but only when the command
 * succeeded. The command is killed after versionCheck.timeoutMs, so a
 * shiprig that hangs fails the check rather than the whole job.
 */
export function requireShiprig(): Promise<void> {
  checked ??= (async () => {
    let version: string;
    try {
      const { stdout } = await execFileAsync(shiprigBin(), ["--version"], {
        timeout: versionCheck.timeoutMs,
        encoding: "utf8",
      });
      version = stdout.trim();
    } catch (err) {
      // Not found, killed by the timeout, or a non-zero exit.
      throw tooOld("Running `shiprig --version`", err);
    }
    if (version.startsWith("source build")) {
      core.warning(
        `shiprig is a source build (${version}); assuming it has what shiprig-action ${MIN_SHIPRIG_VERSION} needs.`,
      );
      return;
    }
    if (!atLeast(version, MIN_SHIPRIG_VERSION)) {
      const found = SEMVER.test(version)
        ? `shiprig ${version}`
        : "an older shiprig (its --version isn't a bare version)";
      throw new Error(
        `shiprig-action needs shiprig ${MIN_SHIPRIG_VERSION} or later on PATH (or at $SHIPRIG_BIN); found ${found}. ` +
          `Install: https://rigsmith.dev/guide/install`,
      );
    }
  })();
  return checked;
}

/** For tests: forget the cached check. */
export function resetShiprigCheck() {
  checked = undefined;
}

/**
 * A semver version, strictly: no leading zeros, no empty prerelease or build
 * part. Anything else fails the check rather than being read generously.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Whether version is strict semver (see SEMVER). */
export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/**
 * Whether version (x.y.z, maybe with a prerelease) is at least min (x.y.z).
 * A prerelease of min counts as below it, as semver orders them.
 */
export function atLeast(version: string, min: string): boolean {
  const m = SEMVER.exec(version);
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const want = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return m[4] === undefined;
}

function tooOld(what: string, err: unknown): Error {
  return new Error(
    `${what} failed. shiprig-action needs shiprig ${MIN_SHIPRIG_VERSION} or later on PATH ` +
      `(or at $SHIPRIG_BIN); an older shiprig lacks this command. ` +
      `Install: https://rigsmith.dev/guide/install`,
    { cause: err },
  );
}

/**
 * Every discovered package, in every ecosystem, as shiprig sees it. Discovery
 * is shiprig's (ecosystem adapters, overlays, ignore and private handling), so
 * this stands in for upstream's npm-only workspace lookup.
 */
export async function listPackages(cwd: string): Promise<ShiprigPackage[]> {
  let output: ExecOutput;
  try {
    output = await getExecOutputShiprig(["packages", "list", "--json"], {
      cwd,
      silent: true,
    });
  } catch (err) {
    throw tooOld("`shiprig packages list --json`", err);
  }
  let parsed: PackagesJson;
  try {
    parsed = JSON.parse(output.stdout);
  } catch (err) {
    throw new Error(
      `\`shiprig packages list --json\` printed something other than JSON:\n${output.stdout}`,
      { cause: err },
    );
  }
  // Fail closed on a record the rest of the action can't use: a blank name or
  // version would otherwise turn into a release title, a PR body heading or a
  // tag lookup that quietly names nothing.
  if (!Array.isArray(parsed?.packages)) {
    throw new Error(
      `\`shiprig packages list --json\` has no "packages" list:\n${output.stdout}`,
    );
  }
  for (const p of parsed.packages) {
    for (const field of [
      "name",
      "version",
      "ecosystem",
      "dir",
      "changelog",
    ] as const) {
      if (typeof p?.[field] !== "string" || p[field].trim() === "") {
        throw new Error(
          `\`shiprig packages list --json\` reported a package with no ${field}: ${JSON.stringify(p)}`,
        );
      }
    }
    for (const field of ["private", "ignored"] as const) {
      if (typeof p?.[field] !== "boolean") {
        throw new Error(
          `\`shiprig packages list --json\` reported a package whose ${field} isn't true or false: ${JSON.stringify(p)}`,
        );
      }
    }
  }
  const root = await workspaceRoot(cwd);
  return parsed.packages.map((p) => ({
    ...p,
    dir: path.resolve(root, p.dir),
    changelog: path.resolve(root, p.changelog),
  }));
}

/**
 * The changelog text holding pkg's entries, or undefined when there is no
 * changelog (changelogs disabled). For a shared file (a stackspace root, one
 * `# <title>` section per package) it is only pkg's section, so a version that
 * two packages share can't pick up the other one's entry.
 */
export async function readChangelog(
  pkg: ShiprigPackage,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(pkg.changelog, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (!pkg.changelogSection) return text;
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => line.trimEnd() === `# ${pkg.changelogSection}`,
  );
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^# /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** A release in the plan `shiprig status --output` writes. */
export type PlannedRelease = {
  name: string;
  type: string;
  newVersion: string;
  // The packages that must be versioned together (shiprig 1.22.0 on): the
  // group's first member.
  group?: string;
};

/**
 * What would release now: the plan `shiprig status --output` writes. Empty
 * means nothing is pending (status exits 0 then, as `changeset status` does);
 * a non-zero exit is a real failure, or the gate (a package changed with no
 * changeset), and is thrown.
 */
export async function readReleasePlan(
  cwd: string,
  { since }: { since?: string } = {},
): Promise<PlannedRelease[]> {
  const planPath = path.join(
    process.env.RUNNER_TEMP ?? (await fs.realpath(os.tmpdir())),
    `shiprig-plan-${randomUUID()}.json`,
  );
  // --since: only the changesets added after that ref, as `changeset status
  // --since` (a PR's own, for pr-status).
  const args = ["status", "--output", planPath];
  if (since) args.push("--since", since);
  const status = await getExecOutputShiprig(args, {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  });
  if (status.exitCode !== 0) {
    throw new Error(
      `\`shiprig status\` exited with code ${status.exitCode}:\n${status.stderr || status.stdout}`,
    );
  }
  let raw: string;
  try {
    raw = await fs.readFile(planPath, "utf8");
  } catch (err) {
    // No plan at all: commit mode with nothing since the last release prints
    // a message instead of writing one.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  } finally {
    await fs.rm(planPath, { force: true });
  }
  return (JSON.parse(raw) as { releases?: PlannedRelease[] }).releases ?? [];
}

/**
 * Whether any changeset file is waiting (README.md aside), even one that
 * releases nothing: upstream's "has-changesets" output and its "all
 * changesets are empty" case both count files, not releases. That's the top of
 * .changeset/, plus .changeset/pre/ once `pre exit` has run: those are the
 * changesets the stable release graduates (upstream counts them in exit mode
 * and leaves them out in pre mode, where they're already released).
 */
export async function hasChangesetFiles(cwd: string): Promise<boolean> {
  const dir = path.join(await workspaceRoot(cwd), ".changeset");
  if (await hasMarkdown(dir)) return true;
  return (
    (await readPreState(cwd))?.mode === "exit" &&
    (await hasMarkdown(path.join(dir, "pre")))
  );
}

async function hasMarkdown(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return false;
  }
  return entries.some(
    (name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md",
  );
}

/**
 * Prerelease mode, from .changeset/pre.json (the v3 shape: mode and tag).
 * Only a missing file means "not in prerelease". A file that can't be read or
 * parsed, or has no valid mode and string tag, is an error rather than a
 * silent normal release or an "(undefined)" PR title.
 */
export async function readPreState(
  cwd: string,
): Promise<{ mode: "pre" | "exit"; tag: string } | undefined> {
  const file = path.join(await workspaceRoot(cwd), ".changeset", "pre.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read ${file}`, { cause: err });
  }
  let pre: unknown;
  try {
    pre = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON`, { cause: err });
  }
  if (
    typeof pre !== "object" ||
    pre === null ||
    !("mode" in pre) ||
    (pre.mode !== "pre" && pre.mode !== "exit") ||
    !("tag" in pre) ||
    typeof pre.tag !== "string" ||
    pre.tag.trim() === ""
  ) {
    throw new Error(
      `${file} is not a valid prerelease state: expected { "mode": "pre" | "exit", "tag": "<tag>" }`,
    );
  }
  return { mode: pre.mode, tag: pre.tag };
}

/**
 * The workspace root shiprig reports paths against: the nearest directory
 * holding .changeset/, else the git root, else cwd (shiprig's FindRoot).
 */
export async function workspaceRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if ((await fs.stat(path.join(dir, ".changeset"))).isDirectory())
        return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const out = await getExecOutput("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    silent: true,
    ignoreReturnCode: true,
  });
  return out.exitCode === 0 ? out.stdout.trim() : cwd;
}
