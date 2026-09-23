// Everything shiprig-specific lives here: the rest of the action is upstream
// changesets/action, and keeping the seams in one module keeps the diff
// against it small enough to go on merging upstream fixes (docs/DESIGN.md).
//
// Each function stands in for an npm-only upstream dependency:
//   listPackages     → @manypkg/get-packages   (`shiprig packages list --json`)
//   readReleasePlan  → @changesets/read + assembleReleasePlan (`shiprig status --output`)
//   readPreState     → @changesets/pre         (.changeset/pre.json)
//   execShiprig      → execChangesetsCli       (`shiprig <verb>`)

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  exec,
  getExecOutput,
  type ExecOptions as ActionsExecOptions,
  type ExecOutput,
} from "@actions/exec";

/** The first shiprig release with every contract this action relies on. */
export const MIN_SHIPRIG_VERSION = "1.20.0";

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
export type PlannedRelease = { name: string; type: string; newVersion: string };

/**
 * What would release now: the plan `shiprig status --output` writes. Empty
 * means nothing is pending (status exits 0 then, as `changeset status` does);
 * a non-zero exit is a real failure, or the gate (a package changed with no
 * changeset), and is thrown.
 */
export async function readReleasePlan(cwd: string): Promise<PlannedRelease[]> {
  const planPath = path.join(
    process.env.RUNNER_TEMP ?? (await fs.realpath(os.tmpdir())),
    `shiprig-plan-${randomUUID()}.json`,
  );
  const status = await getExecOutputShiprig(["status", "--output", planPath], {
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
 * Whether any changeset file is waiting at the top of .changeset/ (README.md
 * aside), even one that releases nothing: upstream's "has-changesets" output
 * and its "all changesets are empty" case both count files, not releases.
 */
export async function hasChangesetFiles(cwd: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(
      path.join(await workspaceRoot(cwd), ".changeset"),
    );
  } catch {
    return false;
  }
  return entries.some(
    (name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md",
  );
}

/** Prerelease mode, from .changeset/pre.json (the v3 shape: mode and tag). */
export async function readPreState(
  cwd: string,
): Promise<{ mode: "pre" | "exit"; tag: string } | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(await workspaceRoot(cwd), ".changeset", "pre.json"),
      "utf8",
    );
    const pre = JSON.parse(raw);
    return pre?.mode === "pre" || pre?.mode === "exit" ? pre : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The workspace root shiprig reports paths against: the nearest directory
 * holding .changeset/, else the git root, else cwd (shiprig's FindRoot).
 */
async function workspaceRoot(cwd: string): Promise<string> {
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
