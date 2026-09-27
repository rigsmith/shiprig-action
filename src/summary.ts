import * as core from "@actions/core";
import { context } from "@actions/github";
import semver from "semver";
import type { VersionChange } from "./run.ts";
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
 * The plan with the versions the run actually wrote: where one differs from
 * the plan (a releaseAs override, and any package sharing its version file),
 * the version it was released at and the bump that version is from the one
 * before (a patch released at 2.0.0 is a major), as shiprig labels it. A
 * package the run moved that the plan never named is added the same way.
 */
export function withFinalVersions(
  releases: PlannedRelease[],
  versions: VersionChange[] = [],
): PlannedRelease[] {
  const byName = new Map(versions.map((v) => [v.name, v]));
  const planned = releases.map((r) => {
    const o = byName.get(r.name);
    if (!o || o.to === r.newVersion) return r;
    return { ...r, newVersion: o.to, type: bumpType(o, r.type) };
  });
  const named = new Set(releases.map((r) => r.name));
  const unplanned = versions
    .filter((v) => !named.has(v.name))
    .map((v) => ({
      name: v.name,
      type: bumpType(v, "patch"),
      newVersion: v.to,
    }));
  return [...planned, ...unplanned];
}

/** The bump from one version to the next, as shiprig labels it. */
function bumpType(v: VersionChange, fallback: string): string {
  const diff =
    semver.valid(v.from) && semver.valid(v.to)
      ? semver.diff(v.from, v.to)
      : null;
  const type = diff?.replace(/^pre(?=major|minor|patch)/, "") ?? fallback;
  return ["major", "minor", "patch"].includes(type) ? type : fallback;
}

/** The version path: what the version PR (or the PR per group) releases. */
export function planSummary(
  releases: PlannedRelease[],
  serverUrl: string,
  pr?: number | number[],
): string {
  const prs = pr === undefined ? [] : Array.isArray(pr) ? pr : [pr];
  const grouped = releases.some((r) => r.group !== undefined) && prs.length > 1;
  const rows = [...releases]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) =>
      grouped
        ? `| \`${r.name}\` | ${r.type} | ${r.newVersion} | ${r.group ?? r.name} |`
        : `| \`${r.name}\` | ${r.type} | ${r.newVersion} |`,
    );
  const lead =
    prs.length === 0
      ? "The version PR wasn't updated by this run."
      : prs.length === 1
        ? `The version PR ${prLink(serverUrl, prs[0])} releases:`
        : `A version PR per release group (${prs.map((n) => prLink(serverUrl, n)).join(", ")}) releases:`;
  return [
    "## shiprig-action: version PR",
    "",
    lead,
    "",
    grouped
      ? "| Package | Bump | Version | Group |"
      : "| Package | Bump | Version |",
    grouped ? "| --- | --- | --- | --- |" : "| --- | --- | --- |",
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
