import { Buffer } from "node:buffer";
import path from "node:path";
import { exec, getExecOutput } from "@actions/exec";
import pkgJson from "../package.json" with { type: "json" };

// The action's publish step. Users take the action from a tag or the release
// line branch (vN), never main, because dist/ only exists in release commits:
// build, commit dist/ on a detached HEAD, tag it vX.Y.Z (shiprig tag, which
// reports the tag through CHANGESETS_OUTPUT so the action creates its GitHub
// release), and move the vN branch to it.

const tag = `v${pkgJson.version}`;
const releaseLine = `v${pkgJson.version.split(".")[0]}`;
const isPrerelease = pkgJson.version.includes("-");
const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  throw new Error("GITHUB_TOKEN is required");
}
const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
};

process.chdir(path.join(import.meta.dirname, ".."));

// Only a new version is released. The action runs this on every push to main
// that has no changesets pending, and upstream force-moves the release line
// each time, so a docs merge (or a change merged without a changeset) would
// put unreleased code into @vN. If this version's tag is already on the
// remote, there is nothing to release.
const existing = await getExecOutput(
  "git",
  ["ls-remote", "--tags", "origin", `refs/tags/${tag}`],
  { env: gitEnv, silent: true },
);
if (existing.stdout.trim() !== "") {
  console.log(`${tag} is already released; nothing to do.`);
  process.exit(0);
}

await exec("git", ["checkout", "--detach"]);
await exec("git", ["add", "--force", "dist"]);
await exec("git", ["commit", "-m", tag]);

await exec("shiprig", ["tag"]);

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
