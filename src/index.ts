import * as core from "@actions/core";
import { GitHub } from "./github.ts";
import { runPublish, runVersion } from "./run.ts";
import { hasChangesetFiles, readReleasePlan } from "./shiprig.ts";
import {
  getOptionalInput,
  getRequiredInput,
  throwOnRemovedCommitModeInput,
  throwOnRenamedInputs,
} from "./utils.ts";

try {
  await main();
} catch (err) {
  core.setFailed((err as Error).message);
}

async function main() {
  const cwd = getOptionalInput("cwd") || process.cwd();

  throwOnRenamedInputs({
    publish: "publish-script",
    version: "version-script",
    commit: "commit-message",
    title: "pr-title",
    branch: "pr-base-branch",
    prDraft: "pr-draft",
    createGithubReleases: "create-github-releases",
  });
  throwOnRemovedCommitModeInput();

  const githubToken = getRequiredInput("github-token");
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== githubToken) {
    throw new Error(
      'The GITHUB_TOKEN environment variable is set and does not match the "github-token" input. ' +
        'Please pass the custom GitHub token to the "github-token" input and ' +
        "remove the GITHUB_TOKEN environment variable to avoid conflicts.",
    );
  }

  const pushWithGitCli = core.getBooleanInput("push-with-git-cli");
  const prDraft = getOptionalInput("pr-draft");
  if (prDraft !== undefined && prDraft !== "always" && prDraft !== "create") {
    core.setFailed(`Invalid pr-draft: ${prDraft}`);
    return;
  }
  const github = new GitHub({
    cwd,
    githubToken,
    pushWithGitCli,
  });

  // shiprig's plan is the answer to "is a release pending?": it covers
  // changesets and conventional commits alike, ignored and private packages,
  // and a prerelease waiting to graduate. Files are still counted, as upstream
  // counts them, for the has-changesets output and the "nothing to release"
  // case (changesets that are empty or name only ignored packages).
  const releases = await readReleasePlan(cwd);
  const hasPendingReleases = releases.length > 0;
  // The has-changesets output keeps its documented meaning (changeset files
  // exist); a conventional-commit release has none. Release work, from files
  // or commits, is what drives the flow below.
  const hasChangesetFilesPresent = await hasChangesetFiles(cwd);
  let hasChangesets = hasPendingReleases || hasChangesetFilesPresent;

  let publishScript = core.getInput("publish-script");
  let hasPublishScript = !!publishScript;

  core.setOutput("published", "false");
  core.setOutput("published-packages", "[]");
  core.setOutput("has-changesets", String(hasChangesetFilesPresent));

  switch (true) {
    case !hasChangesets && !hasPublishScript:
      core.info(
        "No changesets present or were removed by merging version PR. Not publishing because publish-script is not set.",
      );
      return;
    case !hasChangesets && hasPublishScript: {
      core.info(
        "No changesets found. Attempting to publish any unpublished packages",
      );

      const createGithubReleases = core.getBooleanInput(
        "create-github-releases",
      );
      const pushGitTags = core.getBooleanInput("push-git-tags");
      if (createGithubReleases && !pushGitTags) {
        throw new Error(
          "The input 'create-github-releases' is set to true, but 'push-git-tags' is set to false. " +
            "Creating GitHub releases requires pushing git tags. Please set 'push-git-tags' to true " +
            "or set 'create-github-releases' to false.",
        );
      }
      const result = await runPublish({
        script: publishScript,
        github,
        createGithubReleases,
        pushGitTags,
        cwd,
      });

      if (result.published) {
        core.setOutput("published", "true");
        core.setOutput(
          "published-packages",
          JSON.stringify(result.publishedPackages),
        );
      }

      if (result.exitCode !== 0) {
        throw new Error(
          `Publish command exited with code ${result.exitCode}${
            result.published
              ? `, but some packages were published: ${result.publishedPackages
                  .map((p) => `${p.name}@${p.version}`)
                  .join(", ")}`
              : ""
          }`,
        );
      }
      return;
    }
    case hasChangesets && !hasPendingReleases:
      core.info(
        "Changesets are present but nothing would release (they are empty, or name only ignored packages). Not creating PR",
      );
      return;
    case hasChangesets: {
      const { pullRequestNumber } = await runVersion({
        script: getOptionalInput("version-script"),
        github,
        cwd,
        prTitle: getOptionalInput("pr-title"),
        commitMessage: getOptionalInput("commit-message"),
        hasPublishScript,
        prDraft,
        branch: getOptionalInput("pr-base-branch"),
      });

      core.setOutput("pr-number", String(pullRequestNumber));

      return;
    }
  }
}
