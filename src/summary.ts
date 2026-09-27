import * as core from "@actions/core";
import { context } from "@actions/github";
import semver from "semver";
import type { ReleaseOverride } from "./run.ts";
import type { PlannedRelease } from "./shiprig.ts";

// The run's job summary (GITHUB_STEP_SUMMARY): what this run did, readable on
// the run page without opening the version PR or the logs. Best effort: a
// summary that can't be written only warns.

let written = false;

/** Whether this run has written its summary (or tried to). */
export function summaryWritten(): boolean {
  return written;
}

export async function writeSummary(markdown: string): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  written = true;
  try {
    await core.summary.addRaw(markdown, true).write();
  } catch (err) {
    core.warning(`Couldn't write the job summary: ${(err as Error).message}`);
  }
}

function prLink(serverUrl: string, pr: number): string {
  const { owner, repo } = context.repo;
  return `[#${pr}](${serverUrl}/${owner}/${repo}/pull/${pr})`;
}

/**
 * The plan with each releaseAs override applied: the version it was released
 * at, and the bump that version is from the one before (a patch released at
 * 2.0.0 is a major), as shiprig labels it.
 */
export function withOverrides(
  releases: PlannedRelease[],
  overrides: ReleaseOverride[] = [],
): PlannedRelease[] {
  const byName = new Map(overrides.map((o) => [o.name, o]));
  return releases.map((r) => {
    const o = byName.get(r.name);
    if (!o) return r;
    const diff =
      semver.valid(o.from) && semver.valid(o.to)
        ? semver.diff(o.from, o.to)
        : null;
    const type = diff?.replace(/^pre(?=major|minor|patch)/, "") ?? r.type;
    return {
      ...r,
      newVersion: o.to,
      type: ["major", "minor", "patch"].includes(type) ? type : r.type,
    };
  });
}

/** The version path: what the version PR releases. */
export function planSummary(
  releases: PlannedRelease[],
  serverUrl: string,
  pr?: number,
): string {
  const rows = [...releases]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `| \`${r.name}\` | ${r.type} | ${r.newVersion} |`);
  return [
    "## shiprig-action: version PR",
    "",
    pr === undefined
      ? "The version PR wasn't updated by this run."
      : `The version PR ${prLink(serverUrl, pr)} releases:`,
    "",
    "| Package | Bump | Version |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** The publish path: what this run released. */
export function publishedSummary(
  released: { name: string; version: string; tag?: string }[],
  exitCode = 0,
): string {
  const failed =
    exitCode === 0
      ? []
      : [`**The publish command exited with code ${exitCode}.**`, ""];
  if (released.length === 0) {
    return [
      "## shiprig-action: publish",
      "",
      ...failed,
      "Nothing new was released.",
      "",
    ].join("\n");
  }
  const rows = [...released]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (r) =>
        `| \`${r.name}\` | ${r.version} | ${r.tag ? `\`${r.tag}\`` : ""} |`,
    );
  return [
    "## shiprig-action: published",
    "",
    ...failed,
    "| Package | Version | Tag |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Any run that did nothing, with why. */
export function reasonSummary(reason: string): string {
  return `## shiprig-action\n\n${reason}\n`;
}
