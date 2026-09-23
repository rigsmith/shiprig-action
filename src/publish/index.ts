import * as core from "@actions/core";
import { loadConfig, resolveSetting } from "../config.ts";
import { GitHub } from "../github.ts";
import { runPublish } from "../run.ts";
import { getOptionalInput, getRequiredInput } from "../utils.ts";

try {
  await main();
} catch (err) {
  core.setFailed((err as Error).message);
}

async function main() {
  const cwd = getOptionalInput("cwd") || process.cwd();

  const githubToken = getRequiredInput("github-token");
  const script = getOptionalInput("script");
  const packDirArtifactId = getOptionalInput("pack-dir-artifact-id");
  // Rejected before anything is downloaded, with or without a custom script:
  // shiprig has no `publish --from-pack-dir` yet (the split pack/publish flow
  // is phase 4 in docs/DESIGN.md), and a custom script is never handed the
  // directory, so the artifact could only be fetched and ignored.
  if (packDirArtifactId) {
    throw new Error(
      "The 'pack-dir-artifact-id' input isn't supported by shiprig-action yet: " +
        "shiprig can't publish from a pack directory. Omit it, and publish with " +
        "the built-in `shiprig publish` or a custom 'script'.",
    );
  }
  // Each setting: the workflow's input, else shiprig-action.jsonc, else the
  // default here.
  const config = await loadConfig(cwd);
  const createGithubReleases =
    resolveSetting(config, "createGithubReleases") ?? true;
  const pushGitTags = resolveSetting(config, "pushGitTags") ?? true;

  if (createGithubReleases && !pushGitTags) {
    throw new Error(
      "The input 'create-github-releases' is set to true, but 'push-git-tags' is set to false. " +
        "Creating GitHub releases requires pushing git tags. Please set 'push-git-tags' to true " +
        "or set 'create-github-releases' to false.",
    );
  }

  // The publish sub-action always uses the GitHub API for tag pushes.
  const github = new GitHub({ cwd, githubToken });

  const result = await runPublish({
    script,
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
