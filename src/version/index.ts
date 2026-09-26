import * as core from "@actions/core";
import { loadConfig, resolveSetting } from "../config.ts";
import { GitHub } from "../github.ts";
import { runVersion } from "../run.ts";
import { requireShiprig } from "../shiprig.ts";
import {
  getOptionalInput,
  getRequiredInput,
  throwOnRemovedCommitModeInput,
} from "../utils.ts";

try {
  await main();
} catch (err) {
  core.setFailed((err as Error).message);
}

async function main() {
  await requireShiprig();
  const cwd = getOptionalInput("cwd") || process.cwd();
  throwOnRemovedCommitModeInput();

  const githubToken = getRequiredInput("github-token");
  const script = getOptionalInput("script");
  // Each setting: the workflow's input, else shiprig-action.jsonc, else the
  // default here.
  const config = await loadConfig(cwd);
  const commitMessage = resolveSetting(config, "commitMessage");
  const prTitle = resolveSetting(config, "prTitle");
  const prDraft = resolveSetting(config, "prDraft");
  const prBaseBranch = resolveSetting(config, "prBaseBranch");
  const pushWithGitCli = resolveSetting(config, "pushWithGitCli") ?? false;

  // Validations
  if (prDraft !== undefined && prDraft !== "always" && prDraft !== "create") {
    throw new Error(`Invalid pr-draft input: ${prDraft}`);
  }
  const github = new GitHub({
    cwd,
    githubToken,
    pushWithGitCli,
  });

  const { pullRequestNumber, pullRequestNumbers } = await runVersion({
    script,
    github,
    cwd,
    prTitle,
    commitMessage,
    // TODO: Use neutral message for PR description
    hasPublishScript: true,
    prDraft,
    branch: prBaseBranch,
    holdLabel: resolveSetting(config, "holdLabel"),
    releaseAs: resolveSetting(config, "releaseAs"),
    separatePullRequests:
      resolveSetting(config, "separatePullRequests") ?? false,
  });

  core.setOutput("pr-numbers", JSON.stringify(pullRequestNumbers ?? []));
  if (pullRequestNumber !== undefined) {
    core.setOutput("pr-number", String(pullRequestNumber));
  }
}
