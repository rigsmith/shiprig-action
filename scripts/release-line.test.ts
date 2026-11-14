import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "tinyexec";
import { describe, expect, it, vi } from "vitest";
import { gitdir, testdir } from "../src/test-utils.ts";
import { pushRelease, realignReleaseLine } from "./release-line.ts";

const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { nodeOptions: { cwd }, throwOnError: true }))
    .stdout;

// A repository whose origin is a local bare repository, with a release
// commit off main tagged v0.7.0, as release.ts leaves it before pushing.
async function releaseRepo() {
  const work = await gitdir({});
  const remote = await testdir();
  await git(remote.path, "init", "--bare", "--initial-branch=main");
  await git(work.path, "remote", "add", "origin", remote.path);
  await git(work.path, "push", "origin", "main");
  await git(work.path, "checkout", "--detach");
  await git(work.path, "commit", "--allow-empty", "-m", "v0.7.0");
  await git(work.path, "tag", "-a", "v0.7.0", "-m", "v0.7.0");
  const release = (await git(work.path, "rev-parse", "HEAD")).trim();
  return {
    work,
    remote,
    release,
    async [Symbol.asyncDispose]() {
      await work[Symbol.asyncDispose]();
      await remote[Symbol.asyncDispose]();
    },
  };
}

// Each ref on the remote and the commit it names (a tag peeled).
async function remoteRefs(remote: string) {
  const out = await git(
    remote,
    "for-each-ref",
    "--format=%(refname) %(*objectname)%(objectname)",
  );
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, shas] = line.split(" ");
        // %(*objectname) (the peeled commit) comes first for an annotated tag.
        return [ref, shas.slice(0, 40)];
      }),
  );
}

describe("pushRelease", () => {
  it("pushes the release tag and moves the vN branch and tag to it", async () => {
    await using repo = await releaseRepo();

    await pushRelease({
      cwd: repo.work.path,
      tag: "v0.7.0",
      releaseLine: "v0",
      env: { ...process.env } as Record<string, string>,
    });

    expect(await remoteRefs(repo.remote.path)).toMatchObject({
      "refs/tags/v0.7.0": repo.release,
      "refs/heads/v0": repo.release,
      "refs/tags/v0": repo.release,
    });
  });

  it("pushes nothing when the remote refuses one of the refs", async () => {
    await using repo = await releaseRepo();
    // A per-ref hook refusing the vN tag, as a tag ruleset would. Without
    // --atomic, the version tag and the vN branch would still go out.
    const hook = path.join(repo.remote.path, "hooks", "update");
    await fs.writeFile(
      hook,
      '#!/bin/sh\n[ "$1" = refs/tags/v0 ] && { echo "refs/tags/v0 is protected" >&2; exit 1; }\nexit 0\n',
    );
    await fs.chmod(hook, 0o755);

    await expect(
      pushRelease({
        cwd: repo.work.path,
        tag: "v0.7.0",
        releaseLine: "v0",
        env: { ...process.env } as Record<string, string>,
      }),
    ).rejects.toThrow();

    const refs = await remoteRefs(repo.remote.path);
    expect(refs).not.toHaveProperty("refs/tags/v0.7.0");
    expect(refs).not.toHaveProperty("refs/heads/v0");
    expect(refs).not.toHaveProperty("refs/tags/v0");
  });
});

describe("realignReleaseLine", () => {
  it("moves a vN left behind to the release tag", async () => {
    await using repo = await releaseRepo();
    // The version tag went out, but vN still names main's commit.
    const old = (await git(repo.work.path, "rev-parse", "main")).trim();
    await git(
      repo.work.path,
      "push",
      "origin",
      "refs/tags/v0.7.0",
      `${old}:refs/heads/v0`,
      `${old}:refs/tags/v0`,
    );
    // A fresh checkout of main, as the release job has: the release commit
    // isn't in it until fetched.
    await using clone = await testdir();
    await git(
      clone.path,
      "clone",
      "--no-tags",
      "--single-branch",
      repo.remote.path,
      ".",
    );
    const pushEnv = vi.fn(() => ({ ...process.env }) as Record<string, string>);

    const moved = await realignReleaseLine({
      cwd: clone.path,
      tag: "v0.7.0",
      releaseLine: "v0",
      env: { ...process.env } as Record<string, string>,
      pushEnv,
    });

    expect(moved).toBe(true);
    expect(pushEnv).toHaveBeenCalled();
    expect(await remoteRefs(repo.remote.path)).toMatchObject({
      "refs/heads/v0": repo.release,
      "refs/tags/v0": repo.release,
    });
  });

  it("leaves an aligned vN alone, without asking for a push token", async () => {
    await using repo = await releaseRepo();
    await pushRelease({
      cwd: repo.work.path,
      tag: "v0.7.0",
      releaseLine: "v0",
      env: { ...process.env } as Record<string, string>,
    });
    const pushEnv = vi.fn(() => ({ ...process.env }) as Record<string, string>);

    const moved = await realignReleaseLine({
      cwd: repo.work.path,
      tag: "v0.7.0",
      releaseLine: "v0",
      env: { ...process.env } as Record<string, string>,
      pushEnv,
    });

    expect(moved).toBe(false);
    expect(pushEnv).not.toHaveBeenCalled();
  });
});
