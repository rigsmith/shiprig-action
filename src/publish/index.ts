import fs from "node:fs/promises";
import os from "node:os";
import * as core from "@actions/core";
import { loadConfig, resolveSetting } from "../config.ts";
import { GitHub } from "../github.ts";
import { runPublish } from "../run.ts";
import { requireShiprig } from "../shiprig.ts";
import {
  downloadArtifact,
  getOptionalInput,
  getRequiredInput,
} from "../utils.ts";

try {
  await main();
} catch (err) {
  core.setFailed((err as Error).message);
}

async function main() {
  await requireShiprig();
  const cwd = getOptionalInput("cwd") || process.cwd();

  const githubToken = getRequiredInput("github-token");
  const script = getOptionalInput("script");
  const packDirArtifactId = getOptionalInput("pack-dir-artifact-id");
  // Rejected before anything is downloaded: a custom script is never handed
  // the pack directory, so the artifact could only be fetched and ignored.
  if (packDirArtifactId && script) {
    throw new Error(
      "The 'pack-dir-artifact-id' input can't be combined with a custom 'script': " +
        "the script isn't given the pack directory. Omit 'script' to publish the " +
        "packed files with `shiprig publish --from-pack-dir`.",
    );
  }
  // Each setting: the workflow's input, else shiprig-action.jsonc, else the
  // default here.
  const config = await loadConfig(cwd);
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

  // The publish sub-action always uses the GitHub API for tag pushes.
  const github = new GitHub({ cwd, githubToken });

  // The directory `shiprig pack` filled in the pack job, fetched from its
  // artifact.
  const fromPackDir = packDirArtifactId
    ? await downloadArtifact(
        process.env.RUNNER_TEMP ?? (await fs.realpath(os.tmpdir())),
        Number(packDirArtifactId),
        "changeset-pack",
      )
    : undefined;

  const result = await runPublish({
    script,
    fromPackDir,
    github,
    createGithubReleases,
    pushGitTags,
    commentReleasedPrs,
    cwd,
  });

  if (result.published) {
    core.setOutput("published", "true");
    core.setOutput(
      "published-packages",
      JSON.stringify(result.publishedPackages),
    );
  } else {
    core.setOutput("published", "false");
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
}
