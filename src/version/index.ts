import * as core from "@actions/core";
import { GitHub } from "../github.ts";
import { runVersion } from "../run.ts";
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
  const cwd = getOptionalInput("cwd") || process.cwd();
  throwOnRemovedCommitModeInput();

  const githubToken = getRequiredInput("github-token");
  const script = getOptionalInput("script");
  const commitMessage = getOptionalInput("commit-message");
  const prTitle = getOptionalInput("pr-title");
  const prDraft = getOptionalInput("pr-draft");
  const prBaseBranch = getOptionalInput("pr-base-branch");
  const pushWithGitCli = core.getBooleanInput("push-with-git-cli");

  // Validations
  if (prDraft !== undefined && prDraft !== "always" && prDraft !== "create") {
    throw new Error(`Invalid pr-draft input: ${prDraft}`);
  }
  const github = new GitHub({
    cwd,
    githubToken,
    pushWithGitCli,
  });

  const { pullRequestNumber } = await runVersion({
    script,
    github,
    cwd,
    prTitle,
    commitMessage,
    // TODO: Use neutral message for PR description
    hasPublishScript: true,
    prDraft,
    branch: prBaseBranch,
  });

  core.setOutput("pr-number", String(pullRequestNumber));
}
