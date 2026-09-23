import * as core from "@actions/core";
import { context } from "@actions/github";
import { loadConfig, resolveSetting } from "./config.ts";
import { GitHub } from "./github.ts";
import { publishDecision, runPublish, runVersion } from "./run.ts";
import { hasChangesetFiles, readReleasePlan } from "./shiprig.ts";
import {
  planSummary,
  publishedSummary,
  reasonSummary,
  summaryWritten,
  writeSummary,
} from "./summary.ts";
import {
  getOptionalInput,
  getRequiredInput,
  throwOnRemovedCommitModeInput,
  throwOnRenamedInputs,
} from "./utils.ts";

try {
  await main();
} catch (err) {
  const message = (err as Error).message;
  // A failure that came before the run's own summary still gets one.
  if (!summaryWritten()) {
    await writeSummary(reasonSummary(`The run failed: ${message}`));
  }
  core.setFailed(message);
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

  // Each setting: the workflow's input, else shiprig-action.jsonc, else the
  // default here.
  const config = await loadConfig(cwd);
  const pushWithGitCli = resolveSetting(config, "pushWithGitCli") ?? false;
  const prDraft = resolveSetting(config, "prDraft");
  const prBaseBranch = resolveSetting(config, "prBaseBranch");
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
    case !hasChangesets && !hasPublishScript: {
      const reason =
        "No changesets present or were removed by merging version PR. Not publishing because publish-script is not set.";
      core.info(reason);
      await writeSummary(reasonSummary(reason));
      return;
    }
    case !hasChangesets && hasPublishScript: {
      const decision = await publishDecision({
        github,
        publishOn: resolveSetting(config, "publishOn") ?? "version-pr-merge",
        eventName: context.eventName,
        base: prBaseBranch ?? context.ref.replace("refs/heads/", ""),
      });
      core.info(decision.reason);
      if (!decision.publish) {
        await writeSummary(reasonSummary(decision.reason));
        return;
      }

      const createGithubReleases =
        resolveSetting(config, "createGithubReleases") ?? true;
      const pushGitTags = resolveSetting(config, "pushGitTags") ?? true;
      const commentReleasedPrs =
        resolveSetting(config, "commentReleasedPrs") ?? true;
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
        commentReleasedPrs,
        cwd,
      });

      await writeSummary(
        publishedSummary(result.published ? result.released : []),
      );
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
    case hasChangesets && !hasPendingReleases: {
      const reason =
        "Changesets are present but nothing would release (they are empty, or name only ignored packages). Not creating PR";
      core.info(reason);
      await writeSummary(reasonSummary(reason));
      return;
    }
    case hasChangesets: {
      const { pullRequestNumber, skipped } = await runVersion({
        script: getOptionalInput("version-script"),
        github,
        cwd,
        prTitle: resolveSetting(config, "prTitle"),
        commitMessage: resolveSetting(config, "commitMessage"),
        hasPublishScript,
        prDraft,
        branch: prBaseBranch,
        holdLabel: resolveSetting(config, "holdLabel"),
      });

      if (pullRequestNumber !== undefined) {
        core.setOutput("pr-number", String(pullRequestNumber));
      }
      await writeSummary(
        skipped === "stale"
          ? reasonSummary(
              "This run's commit is behind its branch, so the run for the newer commit updates the version PR.",
            )
          : skipped === "held"
            ? reasonSummary(
                `The version PR #${pullRequestNumber} is held by its label, so its branch was left alone.`,
              )
            : planSummary(releases, github.serverUrl, pullRequestNumber),
      );

      return;
    }
  }
}
