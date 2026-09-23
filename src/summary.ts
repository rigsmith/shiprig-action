import * as core from "@actions/core";
import { context } from "@actions/github";
import type { PlannedRelease } from "./shiprig.ts";

// The run's job summary (GITHUB_STEP_SUMMARY): what this run did, readable on
// the run page without opening the version PR or the logs. Best effort: a
// summary that can't be written only warns.

export async function writeSummary(markdown: string): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
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
): string {
  if (released.length === 0) {
    return "## shiprig-action: publish\n\nNothing new was released.\n";
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
