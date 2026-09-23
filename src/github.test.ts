import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "tinyexec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHub } from "./github.ts";
import { createGitHttpRemote, shallowClone, testdir } from "./test-utils.ts";

const githubContext = vi.hoisted(() => ({
  repo: {
    owner: "changesets",
    repo: "action",
  },
  sha: "base-sha",
}));

vi.mock("@actions/github", () => ({
  context: githubContext,
  getOctokit: () => ({}),
}));

async function git(cwd: string, args: string[]) {
  const result = await exec("git", args, {
    nodeOptions: { cwd },
    throwOnError: true,
  });
  return result.stdout.trim();
}

function getAuthorization(token: string) {
  return `basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

// Swaps in a stand-in for the parts of Octokit a test reaches.
function withOctokit(github: GitHub, rest: Record<string, unknown>) {
  (github as unknown as { octokit: unknown }).octokit = { rest };
  return github;
}

const notFound = vi.fn(() =>
  Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
);

function createRemote() {
  return createGitHttpRemote({ "file.txt": "initial\n" });
}

async function isolateGitConfig() {
  const fixture = await testdir({ "global.gitconfig": "" });
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(fixture.path, "global.gitconfig"));
  return fixture;
}

type GitHttpRemote = Awaited<ReturnType<typeof createGitHttpRemote>>;

async function pushChangedFile(
  repository: string,
  serverUrl: string,
  token: string,
) {
  await fs.writeFile(path.join(repository, "file.txt"), "changed\n");
  const github = new GitHub({
    cwd: repository,
    githubToken: token,
    pushWithGitCli: true,
    serverUrl,
  });
  await github.pushChanges({
    branch: "changeset-release/main",
    message: "Version Packages",
  });
  return github;
}

async function expectReleaseBranch(remote: GitHttpRemote, repository: string) {
  expect(
    await git(remote.path, ["rev-parse", "refs/heads/changeset-release/main"]),
  ).toBe(await git(repository, ["rev-parse", "HEAD"]));
}

function expectRequestsToUseToken(remote: GitHttpRemote, token: string) {
  expect(remote.requests.length).toBeGreaterThan(0);
  for (const request of remote.requests) {
    expect(request.headers.authorization).toEqual([getAuthorization(token)]);
  }
}

beforeEach(() => {
  vi.stubEnv("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z");
  vi.stubEnv("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z");
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GitHub", () => {
  it("defaults to GitHub API mode", () => {
    const github = new GitHub({
      cwd: "/repo",
      githubToken: "token",
    });

    expect(github.pushWithGitCli).toBe(false);
  });

  it("uses github-token instead of checkout's persisted header for branch and tag pushes", async () => {
    await using _gitConfig = await isolateGitConfig();
    const actionToken = "action-token";
    const checkoutToken = "checkout-token";
    await using remote = await createRemote();
    await using repositoryFixture = await shallowClone(remote.path);
    const repository = repositoryFixture.path;
    const serverUrl = new URL(remote.url).origin;

    await git(repository, ["remote", "set-url", "origin", remote.url]);
    await git(repository, [
      "config",
      `http.${serverUrl}/.extraheader`,
      `AUTHORIZATION: ${getAuthorization(checkoutToken)}`,
    ]);

    const github = await pushChangedFile(repository, serverUrl, actionToken);
    await git(repository, ["tag", "v1.0.0"]);
    withOctokit(github, { git: { getRef: notFound } });
    await github.pushTag("v1.0.0");

    await expectReleaseBranch(remote, repository);
    expect(await git(remote.path, ["rev-parse", "refs/tags/v1.0.0"])).toBe(
      await git(repository, ["rev-parse", "v1.0.0"]),
    );
    expectRequestsToUseToken(remote, actionToken);
  }, 15_000);

  it("uses github-token instead of credentials embedded in the push URL", async () => {
    await using _gitConfig = await isolateGitConfig();
    const actionToken = "action-token";
    await using remote = await createRemote();
    await using repositoryFixture = await shallowClone(remote.path);
    const repository = repositoryFixture.path;

    const remoteUrl = new URL(remote.url);
    remoteUrl.username = "x-access-token";
    remoteUrl.password = "checkout-token";
    await git(repository, ["remote", "set-url", "origin", remoteUrl.href]);

    const persistedCredentialUrl = new URL(remoteUrl);
    persistedCredentialUrl.password = "";
    await git(repository, [
      "config",
      `http.${persistedCredentialUrl.href}.extraheader`,
      `AUTHORIZATION: ${getAuthorization("checkout-token")}`,
    ]);

    await pushChangedFile(repository, remoteUrl.origin, actionToken);

    await expectReleaseBranch(remote, repository);
    expectRequestsToUseToken(remote, actionToken);
  }, 15_000);

  it("uses the push URL when it differs from the fetch URL", async () => {
    await using _gitConfig = await isolateGitConfig();
    const actionToken = "action-token";
    await using fetchRemote = await createRemote();
    await using pushRemote = await createRemote();
    await using repositoryFixture = await shallowClone(fetchRemote.path);
    const repository = repositoryFixture.path;

    await git(repository, ["remote", "set-url", "origin", fetchRemote.url]);
    await git(repository, ["config", "remote.origin.pushurl", pushRemote.url]);

    await pushChangedFile(
      repository,
      new URL(fetchRemote.url).origin,
      actionToken,
    );

    expect(fetchRemote.requests).toEqual([]);
    await expectReleaseBranch(pushRemote, repository);
    expectRequestsToUseToken(pushRemote, actionToken);
  }, 15_000);

  it("uses github-token for every push URL", async () => {
    await using _gitConfig = await isolateGitConfig();
    const actionToken = "action-token";
    await using firstRemote = await createRemote();
    await using secondRemote = await createRemote();
    await using repositoryFixture = await shallowClone(firstRemote.path);
    const repository = repositoryFixture.path;

    for (const remote of [firstRemote, secondRemote]) {
      await git(repository, [
        "config",
        "--add",
        "remote.origin.pushurl",
        remote.url,
      ]);
    }

    await pushChangedFile(
      repository,
      new URL(firstRemote.url).origin,
      actionToken,
    );

    for (const remote of [firstRemote, secondRemote]) {
      await expectReleaseBranch(remote, repository);
      expectRequestsToUseToken(remote, actionToken);
    }
  }, 15_000);

  it("preserves existing command-scoped Git config entries", async () => {
    await using _gitConfig = await isolateGitConfig();
    const actionToken = "action-token";
    await using fetchRemote = await createRemote();
    await using pushRemote = await createRemote();
    await using repositoryFixture = await shallowClone(fetchRemote.path);
    const repository = repositoryFixture.path;

    await git(repository, ["remote", "set-url", "origin", fetchRemote.url]);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "remote.origin.pushurl");
    vi.stubEnv("GIT_CONFIG_VALUE_0", pushRemote.url);

    await pushChangedFile(
      repository,
      new URL(fetchRemote.url).origin,
      actionToken,
    );

    expect(fetchRemote.requests).toEqual([]);
    await expectReleaseBranch(pushRemote, repository);
    expectRequestsToUseToken(pushRemote, actionToken);
  }, 15_000);
});

describe("pushTag via the API", () => {
  function apiGitHub(getRef: () => Promise<unknown>) {
    const createRef = vi.fn(() => Promise.resolve({}));
    const github = withOctokit(new GitHub({ cwd: ".", githubToken: "t" }), {
      git: { getRef, createRef },
    });
    return { github, createRef };
  }

  it("leaves a tag the publish script already pushed", async () => {
    const { github, createRef } = apiGitHub(() => Promise.resolve({}));
    await github.pushTag("v1.0.0");
    expect(createRef).not.toHaveBeenCalled();
  });

  it("creates a tag that isn't on GitHub yet", async () => {
    const { github, createRef } = apiGitHub(notFound);
    await github.pushTag("v1.0.0");
    expect(createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "refs/tags/v1.0.0", sha: "base-sha" }),
    );
  });

  it("fails when the tag can't be created, rather than assuming it was pushed", async () => {
    const { github, createRef } = apiGitHub(notFound);
    createRef.mockImplementationOnce(() =>
      Promise.reject(new Error("Resource not accessible by integration")),
    );
    await expect(github.pushTag("v1.0.0")).rejects.toThrow(
      "Resource not accessible",
    );
  });

  it("fails when GitHub can't say whether the tag exists", async () => {
    const { github } = apiGitHub(() =>
      Promise.reject(Object.assign(new Error("Server Error"), { status: 500 })),
    );
    await expect(github.pushTag("v1.0.0")).rejects.toThrow("Server Error");
  });
});

describe("isVersionPrMerge", () => {
  function withPulls(pulls: unknown[]) {
    return withOctokit(new GitHub({ cwd: ".", githubToken: "t" }), {
      repos: {
        listPullRequestsAssociatedWithCommit: () =>
          Promise.resolve({ data: pulls }),
      },
    });
  }
  const merged = {
    merged_at: "2026-09-23T00:00:00Z",
    head: { ref: "changeset-release/main" },
    base: { ref: "main" },
  };

  it("is true for the merged version PR", async () => {
    expect(
      await withPulls([merged]).isVersionPrMerge(
        "changeset-release/main",
        "main",
      ),
    ).toBe(true);
  });

  it.each([
    ["an unmerged version PR", { ...merged, merged_at: null }],
    ["another branch's PR", { ...merged, head: { ref: "feature" } }],
    ["a version PR into another base", { ...merged, base: { ref: "next" } }],
  ])("is false for %s", async (_, pull) => {
    expect(
      await withPulls([pull]).isVersionPrMerge(
        "changeset-release/main",
        "main",
      ),
    ).toBe(false);
  });

  it("is false for a commit no PR is associated with", async () => {
    expect(
      await withPulls([]).isVersionPrMerge("changeset-release/main", "main"),
    ).toBe(false);
  });
});
