import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { exec, getExecOutput } from "@actions/exec";
import pkgJson from "../package.json" with { type: "json" };

// The action's publish step. Users take the action from a tag or the release
// line branch (vN), never main, because dist/ only exists in release commits:
// build, commit dist/ on a detached HEAD, tag it vX.Y.Z (shiprig tag), move the
// vN branch to it, and only then report the tag through CHANGESETS_OUTPUT so the
// action creates its GitHub release.

const tag = `v${pkgJson.version}`;
const releaseLine = `v${pkgJson.version.split(".")[0]}`;
const isPrerelease = pkgJson.version.includes("-");
// GITHUB_TOKEN is the action's github-token: it only reads the GitHub release.
// The git pushes below use RELEASE_GIT_TOKEN, a shipRig App token that can
// also write workflow files (release.yml mints it): GitHub refuses to move vN
// across commits that change .github/workflows without that permission, which
// neither the action's token nor the job's GITHUB_TOKEN has.
const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  throw new Error("GITHUB_TOKEN is required");
}
const gitToken = process.env.RELEASE_GIT_TOKEN;
if (!gitToken) {
  throw new Error(
    "RELEASE_GIT_TOKEN is required: a token that can push contents and workflow files",
  );
}
const basic = Buffer.from(`x-access-token:${gitToken}`).toString("base64");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
};

process.chdir(path.join(import.meta.dirname, ".."));

// The event that tells the action to create this version's GitHub release
// (the CHANGESETS_OUTPUT contract). It is written only once the tag is on the
// remote, pointing at the commit with dist/: written earlier, a failed push
// would leave the action creating the tag itself at main's commit, without
// dist/, and releasing that.
function reportTag() {
  const output = process.env.CHANGESETS_OUTPUT;
  if (!output) return;
  fs.appendFileSync(
    output,
    `${JSON.stringify({ type: "git-tag", tag, packageName: pkgJson.name })}\n`,
  );
}

async function hasGitHubRelease(): Promise<boolean> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required");
  }
  const res = await fetch(
    `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}/releases/tags/${tag}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${githubToken}`,
      },
    },
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(
      `Checking for the ${tag} release: ${res.status} ${await res.text()}`,
    );
  }
  return true;
}

// Only a new version is released. The action runs this on every push to main
// that has no changesets pending, and upstream force-moves the release line
// each time, so a docs merge (or a change merged without a changeset) would
// put unreleased code into @vN. If this version's tag is already on the
// remote, the release line isn't touched; but a run that pushed the tag and
// then failed to create the GitHub release is finished here, by reporting
// the tag again so the action creates the missing release.
const existing = await getExecOutput(
  "git",
  ["ls-remote", "--tags", "origin", `refs/tags/${tag}`],
  { env: gitEnv, silent: true },
);
if (existing.stdout.trim() !== "") {
  if (await hasGitHubRelease()) {
    console.log(`${tag} is already released; nothing to do.`);
  } else {
    console.log(
      `${tag} is tagged but has no GitHub release; reporting it so the action creates one.`,
    );
    reportTag();
  }
  process.exit(0);
}

await exec("git", ["checkout", "--detach"]);
await exec("git", ["add", "--force", "dist"]);
await exec("git", ["commit", "-m", tag]);

// Tag without reporting: the event is written after the push (reportTag).
await exec("shiprig", ["tag"], {
  env: { ...process.env, CHANGESETS_OUTPUT: "" },
});

if (isPrerelease) {
  await exec("git", ["push", "origin", `refs/tags/${tag}`], {
    env: gitEnv,
  });
} else {
  await exec(
    "git",
    [
      "push",
      "--force",
      "--follow-tags",
      "origin",
      `HEAD:refs/heads/${releaseLine}`,
    ],
    {
      env: gitEnv,
    },
  );
}

reportTag();
