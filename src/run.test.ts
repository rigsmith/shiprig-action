import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { commitChangesSinceBase } from "@changesets/ghcommit";
import type { Changeset } from "@changesets/types";
import { writeChangeset } from "@changesets/write";
import { exec } from "tinyexec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHub } from "./github.ts";
import {
  branchSlug,
  publishDecision,
  releaseTitle,
  runPublish,
  runVersion,
  releaseAsArgs,
} from "./run.ts";
import type { ShiprigPackage } from "./shiprig.ts";
import { gitdir } from "./test-utils.ts";

vi.mock("@actions/github", () => ({
  context: {
    repo: {
      owner: "changesets",
      repo: "action",
    },
    ref: "refs/heads/some-branch",
    sha: "xeac7",
  },
  getOctokit: () => ({
    rest: mockedGithubMethods,
    graphql: mockedGraphql,
  }),
}));
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  error: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@changesets/ghcommit");

let mockedGithubMethods = {
  pulls: {
    create: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
  },
  repos: {
    createRelease: vi.fn(),
    // The release commit, for "released in" comments: no changesets consumed.
    getCommit: vi.fn(() =>
      Promise.resolve({ data: { parents: [{ sha: "parent" }], files: [] } }),
    ),
  },
  git: {
    getRef: vi.fn(),
  },
  issues: {
    listComments: vi.fn(() => Promise.resolve({ data: [] })),
    createComment: vi.fn((_: { issue_number: number }) =>
      Promise.resolve({ data: {} }),
    ),
  },
};
let mockedGraphql = vi.fn();

const nodeModulesDir = path.join(import.meta.dirname, "..", "node_modules");

function createSimpleProjectFixture() {
  return gitdir({
    node_modules: (api) => api.symlink(nodeModulesDir),
    ".changeset/config.json": JSON.stringify({}),
    "packages/pkg-a/package.json": JSON.stringify({
      name: "changesets-dev-simple-project-pkg-a",
      version: "1.0.0",
      dependencies: {
        "changesets-dev-simple-project-pkg-b": "1.0.0",
      },
    }),
    "packages/pkg-b/package.json": JSON.stringify({
      name: "changesets-dev-simple-project-pkg-b",
      version: "1.0.0",
    }),
    "package.json": JSON.stringify({
      name: "simple-project",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "",
  });
}

function createIgnoredPackageFixture() {
  return gitdir({
    node_modules: (api) => api.symlink(nodeModulesDir),
    ".changeset/config.json": JSON.stringify({
      ignore: ["changesets-dev-ignored-package-pkg-a"],
    }),
    "packages/pkg-a/package.json": JSON.stringify({
      name: "changesets-dev-ignored-package-pkg-a",
      version: "1.0.0",
      dependencies: {
        "changesets-dev-ignored-package-pkg-b": "1.0.0",
      },
    }),
    "packages/pkg-b/package.json": JSON.stringify({
      name: "changesets-dev-ignored-package-pkg-b",
      version: "1.0.0",
    }),
    "package.json": JSON.stringify({
      name: "ignored-package",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "",
  });
}

const writeChangesets = (changesets: Changeset[], cwd: string) => {
  return Promise.all(changesets.map((commit) => writeChangeset(commit, cwd)));
};

const createGithub = (cwd: string) =>
  new GitHub({
    cwd,
    githubToken: "@@GITHUB_TOKEN",
    pushWithGitCli: false,
  });

async function updateGithubContext(cwd: string) {
  const head = await exec("git", ["rev-parse", "HEAD"], {
    nodeOptions: { cwd },
  });
  github.context.sha = head.stdout.trim();
}

function resetGithubContext() {
  github.context.sha = "xeac7";
}

beforeEach(() => {
  vi.clearAllMocks();
  // The base branch still points at this run's commit unless a test says
  // otherwise. Reset, not just cleared, so a response one test queued and
  // didn't use can't reach the next.
  mockedGithubMethods.git.getRef
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve({ data: { object: { sha: github.context.sha } } }),
    );
  // Every listing of the version PR sees the same PRs unless a test says
  // otherwise; none by default.
  mockedGithubMethods.pulls.list
    .mockReset()
    .mockImplementation(() => ({ data: [] }));
  resetGithubContext();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publish", () => {
  it("warns when a custom publish script does not create the output file", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);

    const result = await runPublish({
      script: 'node -e "void 0"',
      github: createGithub(cwd),
      createGithubReleases: true,
      pushGitTags: true,
      cwd,
    });

    expect(result).toEqual({ published: false, exitCode: 0 });
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "GitHub releases and git tags cannot be created without this output",
      ),
    );
  });

  it("throws when the built-in publish command does not create the output file", async () => {
    // A stand-in shiprig that publishes nothing and writes no tag events:
    // the real one would reach the npm registry from a test.
    await using fixture = await gitdir({
      "fake-shiprig":
        '#!/bin/sh\ncase "$1" in packages) echo \'{"packages":[]}\' ;; esac\nexit 0\n',
      ".changeset/config.json": JSON.stringify({}),
      "package.json": JSON.stringify({
        name: "simple-project",
        version: "1.0.0",
      }),
      "package-lock.json": "",
    });
    const cwd = fixture.path;
    await fs.chmod(path.join(cwd, "fake-shiprig"), 0o755);
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);
    vi.stubEnv("SHIPRIG_BIN", path.join(cwd, "fake-shiprig"));

    await expect(
      runPublish({
        github: createGithub(cwd),
        createGithubReleases: true,
        pushGitTags: true,
        cwd,
      }),
    ).rejects.toThrow("Failed to read changesets output at");
  });
});

describe("publish checks the package list first", () => {
  it("stops before publishing when the list is malformed", async () => {
    // A stand-in shiprig whose package list has a blank version: the run must
    // fail before the publish script runs, not after it has published.
    await using fixture = await gitdir({
      "fake-shiprig": `#!/bin/sh\ncase "$1" in packages) echo '${JSON.stringify(
        {
          packages: [
            {
              name: "pkg",
              version: " ",
              ecosystem: "npm",
              dir: ".",
              changelog: "CHANGELOG.md",
              private: false,
              ignored: false,
            },
          ],
        },
      )}' ;; esac\nexit 0\n`,
      ".changeset/config.json": JSON.stringify({}),
      "package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
      "package-lock.json": "",
    });
    const cwd = fixture.path;
    await fs.chmod(path.join(cwd, "fake-shiprig"), 0o755);
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);
    vi.stubEnv("SHIPRIG_BIN", path.join(cwd, "fake-shiprig"));

    await expect(
      runPublish({
        script: "touch published",
        github: createGithub(cwd),
        createGithubReleases: true,
        pushGitTags: true,
        cwd,
      }),
    ).rejects.toThrow("reported a package with no version");
    await expect(fs.access(path.join(cwd, "published"))).rejects.toThrow();
  });
});

describe("publish reads versions after the script", () => {
  it("reports the version a custom script published, not the one before it ran", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);
    // A script that bumps pkg-a and reports the tag for the new version.
    await fs.writeFile(
      path.join(cwd, "bump-and-tag.mjs"),
      `import fs from "node:fs";
const file = "packages/pkg-a/package.json";
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = "9.9.9";
fs.writeFileSync(file, JSON.stringify(pkg));
fs.appendFileSync(process.env.CHANGESETS_OUTPUT, JSON.stringify({
  type: "git-tag",
  tag: "changesets-dev-simple-project-pkg-a@9.9.9",
  packageName: "changesets-dev-simple-project-pkg-a",
}) + "\\n");
`,
    );

    const result = await runPublish({
      script: "node bump-and-tag.mjs",
      github: createGithub(cwd),
      createGithubReleases: false,
      pushGitTags: false,
      cwd,
    });

    expect(result).toMatchObject({
      published: true,
      publishedPackages: [
        { name: "changesets-dev-simple-project-pkg-a", version: "9.9.9" },
      ],
    });
  });
});

describe("version", () => {
  it("creates simple PR", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));

    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
            {
              name: "changesets-dev-simple-project-pkg-b",
              type: "minor",
            },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0]).toMatchSnapshot();
  });

  it("keeps a title and commit message the user set, with the prerelease suffix", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    await fs.writeFile(
      path.join(cwd, ".changeset", "pre.json"),
      JSON.stringify({ mode: "pre", tag: "beta" }),
    );
    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));
    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      prTitle: "Release it",
      commitMessage: "Ship it",
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0][0].title).toBe(
      "Release it (beta)",
    );
    expect(vi.mocked(commitChangesSinceBase).mock.calls[0][0].message).toBe(
      "Ship it (beta)",
    );
  });

  it("names the prerelease version in the default title, with no suffix", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    await fs.writeFile(
      path.join(cwd, ".changeset", "pre.json"),
      JSON.stringify({ mode: "pre", tag: "beta" }),
    );
    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));
    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({ github: createGithub(cwd), cwd });

    const title: string =
      mockedGithubMethods.pulls.create.mock.calls[0][0].title;
    expect(title).toMatch(/^chore: release 1\.1\.0-beta\.\d+$/);
    expect(vi.mocked(commitChangesSinceBase).mock.calls[0][0].message).toBe(
      title,
    );
  });

  it("leaves the version PR alone when the base has moved past the run's commit", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.git.getRef.mockImplementationOnce(() =>
      Promise.resolve({ data: { object: { sha: "a-newer-commit" } } }),
    );
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );
    const headBefore = (
      await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        nodeOptions: { cwd },
      })
    ).stdout.trim();

    const result = await runVersion({ github: createGithub(cwd), cwd });

    expect(result).toEqual({ skipped: "stale", pullRequestNumbers: [] });
    expect(mockedGithubMethods.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/some-branch" }),
    );
    expect(mockedGithubMethods.pulls.list).not.toHaveBeenCalled();
    expect(mockedGithubMethods.pulls.create).not.toHaveBeenCalled();
    expect(vi.mocked(commitChangesSinceBase)).not.toHaveBeenCalled();
    // Not even switched to the version branch.
    expect(
      (
        await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          nodeOptions: { cwd },
        })
      ).stdout.trim(),
    ).toBe(headBefore);
  });

  it("leaves the version PR alone when the base moves on while it versions", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));
    mockedGithubMethods.git.getRef
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { object: { sha: github.context.sha } } }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { object: { sha: "a-newer-commit" } } }),
      );
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    const result = await runVersion({ github: createGithub(cwd), cwd });

    expect(result).toEqual({ skipped: "stale", pullRequestNumbers: [] });
    expect(mockedGithubMethods.git.getRef).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commitChangesSinceBase)).not.toHaveBeenCalled();
    expect(mockedGithubMethods.pulls.create).not.toHaveBeenCalled();
  });

  it("checks the branch the run is on, not a different pr-base-branch", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));
    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    // The run is on some-branch (the mocked context.ref); the PR targets main.
    const result = await runVersion({
      github: createGithub(cwd),
      cwd,
      branch: "main",
    });

    expect(result).toEqual({
      pullRequestNumber: 123,
      pullRequestNumbers: [123],
    });
    expect(mockedGithubMethods.git.getRef).toHaveBeenCalledTimes(2);
    for (const [args] of mockedGithubMethods.git.getRef.mock.calls) {
      expect(args).toMatchObject({ ref: "heads/some-branch" });
    }
  });

  it("leaves a version PR with the hold label alone", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list.mockImplementation(() => ({
      data: [{ number: 5, labels: [{ name: "release:hold" }] }],
    }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    const result = await runVersion({ github: createGithub(cwd), cwd });

    expect(result).toEqual({
      pullRequestNumber: 5,
      pullRequestNumbers: [5],
      skipped: "held",
    });
    expect(vi.mocked(commitChangesSinceBase)).not.toHaveBeenCalled();
    expect(mockedGithubMethods.pulls.create).not.toHaveBeenCalled();
    expect(mockedGraphql).not.toHaveBeenCalled();
  });

  it("leaves the version PR alone when it's held while the script runs", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list
      .mockImplementationOnce(() => ({ data: [{ number: 5, labels: [] }] }))
      .mockImplementationOnce(() => ({
        data: [{ number: 5, labels: [{ name: "release:hold" }] }],
      }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    const result = await runVersion({ github: createGithub(cwd), cwd });

    expect(result).toEqual({
      pullRequestNumber: 5,
      pullRequestNumbers: [5],
      skipped: "held",
    });
    expect(mockedGithubMethods.pulls.list).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commitChangesSinceBase)).not.toHaveBeenCalled();
    expect(mockedGraphql).not.toHaveBeenCalled();
  });

  it("updates a version PR another run opened while the script ran", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list
      .mockImplementationOnce(() => ({ data: [] }))
      .mockImplementationOnce(() => ({ data: [{ number: 7, labels: [] }] }));
    mockedGraphql.mockImplementation(() => ({}));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    const result = await runVersion({ github: createGithub(cwd), cwd });

    expect(result.pullRequestNumber).toBe(7);
    expect(mockedGithubMethods.pulls.create).not.toHaveBeenCalled();
  });

  it("uses a hold label the user named, and ignores other labels", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list.mockImplementation(() => ({
      data: [{ number: 5, labels: [{ name: "release:hold" }] }],
    }));
    mockedGraphql.mockImplementation(() => ({}));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    // "release:hold" isn't the hold label here, so the PR is updated.
    const result = await runVersion({
      github: createGithub(cwd),
      cwd,
      holdLabel: "do-not-release",
    });

    expect(result.skipped).toBeUndefined();
    expect(vi.mocked(commitChangesSinceBase)).toHaveBeenCalled();
  });

  it('creates a draft PR when prDraft is "create"', async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));

    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      prDraft: "create",
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0]).toMatchSnapshot();
  });

  it("only includes bumped packages in the PR body", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));

    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0]).toMatchSnapshot();
  });

  it("doesn't include ignored package that got a dependency update in the PR body", async () => {
    await using fixture = await createIgnoredPackageFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));

    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-ignored-package-pkg-b",
              type: "minor",
            },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0]).toMatchSnapshot();
  });

  it("does not include changelog entries if full message exceeds size limit", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));

    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
          ],
          summary: `# Non manus superum

## Nec cornibus aequa numinis multo onerosior adde

Lorem markdownum undas consumpserat malas, nec est lupus; memorant gentisque ab
limine auctore. Eatque et promptu deficit, quam videtur aequa est **faciat**,
locus. Potentia deus habebat pia quam qui coniuge frater, tibi habent fertque
viribus. E et cognoscere arcus, lacus aut sic pro crimina fuit tum **auxilium**
dictis, qua, in.

In modo. Nomen illa membra.

> Corpora gratissima parens montibus tum coeperat qua remulus caelum Helenamque?
> Non poenae modulatur Amathunta in concita superi, procerum pariter rapto cornu
> munera. Perrhaebum parvo manus contingere, morari, spes per totiens ut
> dividite proculcat facit, visa.

Adspicit sequitur diffamatamque superi Phoebo qua quin lammina utque: per? Exit
decus aut hac inpia, seducta mirantia extremo. Vidi pedes vetus. Saturnius
fluminis divesque vulnere aquis parce lapsis rabie si visa fulmineis.
`,
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      prBodyMaxCharacters: 1000,
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0]).toMatchSnapshot();
    expect(mockedGithubMethods.pulls.create.mock.calls[0][0].body).toMatch(
      /The changelog information of each package has been omitted from this message/,
    );
  });

  it("does not include any release information if a message with simplified release info exceeds size limit", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));

    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
          ],
          summary: `# Non manus superum

## Nec cornibus aequa numinis multo onerosior adde

Lorem markdownum undas consumpserat malas, nec est lupus; memorant gentisque ab
limine auctore. Eatque et promptu deficit, quam videtur aequa est **faciat**,
locus. Potentia deus habebat pia quam qui coniuge frater, tibi habent fertque
viribus. E et cognoscere arcus, lacus aut sic pro crimina fuit tum **auxilium**
dictis, qua, in.

In modo. Nomen illa membra.

> Corpora gratissima parens montibus tum coeperat qua remulus caelum Helenamque?
> Non poenae modulatur Amathunta in concita superi, procerum pariter rapto cornu
> munera. Perrhaebum parvo manus contingere, morari, spes per totiens ut
> dividite proculcat facit, visa.

Adspicit sequitur diffamatamque superi Phoebo qua quin lammina utque: per? Exit
decus aut hac inpia, seducta mirantia extremo. Vidi pedes vetus. Saturnius
fluminis divesque vulnere aquis parce lapsis rabie si visa fulmineis.
`,
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      prBodyMaxCharacters: 500,
    });

    expect(mockedGithubMethods.pulls.create.mock.calls[0]).toMatchSnapshot();
    expect(mockedGithubMethods.pulls.create.mock.calls[0][0].body).toMatch(
      /All release information have been omitted from this message, as the content exceeds the size limit/,
    );
  });

  it('updates an existing PR via GraphQL without converting it to draft when prDraft is "create"', async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({
      data: [{ number: 123, node_id: "PR_kwDOA" }],
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      prDraft: "create",
    });

    expect(mockedGraphql.mock.calls[0]).toMatchSnapshot();
  });

  it('updates an existing PR via GraphQL and converts it to draft when prDraft is "always"', async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);

    mockedGithubMethods.pulls.list.mockImplementation(() => ({
      data: [{ number: 123, node_id: "PR_kwDOA" }],
    }));

    await writeChangesets(
      [
        {
          releases: [
            {
              name: "changesets-dev-simple-project-pkg-a",
              type: "minor",
            },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      prDraft: "always",
    });

    expect(mockedGraphql.mock.calls[0]).toMatchSnapshot();
  });
});

// The point of shiprig-action: one version PR and one set of releases across
// every ecosystem shiprig discovers, not just npm.
function createPolyglotFixture() {
  return gitdir({
    ".changeset/config.json": JSON.stringify({}),
    "package.json": JSON.stringify({
      name: "polyglot",
      private: true,
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "",
    "packages/pkg-a/package.json": JSON.stringify({
      name: "pkg-a",
      version: "1.0.0",
    }),
    "packages/pkg-a/CHANGELOG.md":
      "# pkg-a\n\n## 1.0.0\n\n### Major Changes\n\n- Node first release\n",
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
    "crates/crate-b/Cargo.toml":
      '[package]\nname = "crate-b"\nversion = "0.3.0"\nedition = "2021"\n',
    "crates/crate-b/src/main.rs": "fn main() {}\n",
    "crates/crate-b/CHANGELOG.md":
      "# crate-b\n\n## 0.3.0\n\n### Minor Changes\n\n- Rust first release\n",
  });
}

describe("polyglot", () => {
  it("opens one version PR for releases in every ecosystem", async () => {
    await using fixture = await createPolyglotFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));
    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 7 },
    }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "pkg-a", type: "minor" },
            { name: "crate-b", type: "patch" },
          ],
          summary: "A polyglot change",
        },
      ],
      cwd,
    );

    const result = await runVersion({ github: createGithub(cwd), cwd });

    expect(result).toEqual({ pullRequestNumber: 7, pullRequestNumbers: [7] });
    // Two packages at different versions: each named, in the title and the
    // commit alike.
    const title = "chore: release crate-b@0.3.1, pkg-a@1.1.0";
    expect(mockedGithubMethods.pulls.create.mock.calls[0][0].title).toBe(title);
    expect(vi.mocked(commitChangesSinceBase).mock.calls[0][0].message).toBe(
      title,
    );
    const body: string = mockedGithubMethods.pulls.create.mock.calls[0][0].body;
    expect(body).toContain("## pkg-a@1.1.0");
    expect(body).toContain("## crate-b@0.3.1");
    expect(body.match(/A polyglot change/g)).toHaveLength(2);
    // shiprig stamped the crate's own manifest.
    expect(
      await fs.readFile(path.join(cwd, "crates/crate-b/Cargo.toml"), "utf8"),
    ).toContain('version = "0.3.1"');
  });

  it("creates a GitHub release for every tag shiprig reports, whatever its ecosystem", async () => {
    await using fixture = await createPolyglotFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);

    // `shiprig tag` writes the same CHANGESETS_OUTPUT events `shiprig
    // publish` does, without reaching a registry.
    const result = await runPublish({
      script: `${process.env.SHIPRIG_BIN} tag`,
      github: createGithub(cwd),
      createGithubReleases: true,
      pushGitTags: false,
      cwd,
    });

    expect(result).toEqual({
      published: true,
      publishedPackages: expect.arrayContaining([
        { name: "pkg-a", version: "1.0.0" },
        { name: "crate-b", version: "0.3.0" },
      ]),
      released: expect.arrayContaining([
        { name: "pkg-a", version: "1.0.0", tag: "pkg-a@1.0.0" },
        { name: "crate-b", version: "0.3.0", tag: "crate-b@0.3.0" },
      ]),
      exitCode: 0,
    });
    const releases = mockedGithubMethods.repos.createRelease.mock.calls.map(
      ([arg]) => [arg.tag_name, arg.body.trim()],
    );
    expect(releases).toEqual(
      expect.arrayContaining([
        ["pkg-a@1.0.0", "### Major Changes\n\n- Node first release"],
        ["crate-b@0.3.0", "### Minor Changes\n\n- Rust first release"],
      ]),
    );
  });
});

describe("publish from a pack directory", () => {
  // Directories made beside the fixture (inside it, discovery would see the
  // staged package.json as a second pkg-a), removed after each test.
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function packDir(cwd: string, plan: unknown[]) {
    const dir = path.join(cwd, "..", `pack-${path.basename(cwd)}`);
    made.push(dir);
    await fs.mkdir(path.join(dir, "packages"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "publish-plan.json"),
      JSON.stringify({ version: 1, plan }),
    );
    return dir;
  }

  // An empty pack plan publishes nothing and reaches no registry; the tags
  // still go out, as shiprig publish tags the release either way.
  it("runs shiprig publish --from-pack-dir", async () => {
    await using fixture = await createPolyglotFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);

    const result = await runPublish({
      fromPackDir: await packDir(cwd, []),
      github: createGithub(cwd),
      createGithubReleases: false,
      pushGitTags: false,
      cwd,
    });
    expect(result).toMatchObject({
      published: true,
      publishedPackages: expect.arrayContaining([
        { name: "pkg-a", version: "1.0.0" },
      ]),
      exitCode: 0,
    });
  });

  // A file that no longer matches what pack recorded: shiprig refuses before
  // pushing, which it only does when it was given the pack directory.
  // pack recorded the tarball's sha256; the file changed afterwards. shiprig
  // refuses before pushing anything, which it only does when it was handed
  // the pack directory.
  it("fails when a packed file was changed", async () => {
    await using fixture = await createPolyglotFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    vi.stubEnv("RUNNER_TEMP", cwd);

    // A real npm tarball, recorded as pack would record it.
    const staging = path.join(cwd, "..", `stage-${path.basename(cwd)}`);
    made.push(staging);
    await fs.mkdir(path.join(staging, "package"), { recursive: true });
    await fs.writeFile(
      path.join(staging, "package", "package.json"),
      JSON.stringify({ name: "pkg-a", version: "1.0.0" }),
    );
    const tarball = path.join(staging, "pkg-a-1.0.0.tgz");
    await exec("tar", ["-czf", tarball, "-C", staging, "package"], {
      throwOnError: true,
    });
    const original = await fs.readFile(tarball);
    const integrity = `sha256-${createHash("sha256").update(original).digest("base64")}`;
    const dir = await packDir(cwd, [
      [
        {
          kind: "publish",
          name: "pkg-a",
          version: "1.0.0",
          tarball: { path: "packages/pkg-a-1.0.0.tgz", integrity },
        },
      ],
    ]);
    // The packed file, changed after pack recorded it.
    await fs.writeFile(
      path.join(dir, "packages", "pkg-a-1.0.0.tgz"),
      Buffer.concat([original, Buffer.from("tampered")]),
    );

    // shiprig's output goes through @actions/exec to the process streams.
    let output = "";
    const capture = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    let result;
    try {
      result = await runPublish({
        fromPackDir: dir,
        github: createGithub(cwd),
        createGithubReleases: false,
        pushGitTags: false,
        cwd,
      });
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(result.exitCode).not.toBe(0);
    expect(result.published).toBe(false);
    expect(output).toContain("doesn't match the integrity pack recorded");
  });
});

describe("publish comments on the released pull requests", () => {
  it.each([true, false])(
    "looks at the release commit only when commentReleasedPrs is %s",
    async (commentReleasedPrs) => {
      await using fixture = await createPolyglotFixture();
      const cwd = fixture.path;
      await updateGithubContext(cwd);
      vi.stubEnv("RUNNER_TEMP", cwd);

      await runPublish({
        script: `${process.env.SHIPRIG_BIN} tag`,
        github: createGithub(cwd),
        createGithubReleases: false,
        pushGitTags: true,
        commentReleasedPrs,
        cwd,
      });

      if (commentReleasedPrs) {
        expect(mockedGithubMethods.repos.getCommit).toHaveBeenCalledWith(
          expect.objectContaining({ ref: github.context.sha }),
        );
      } else {
        expect(mockedGithubMethods.repos.getCommit).not.toHaveBeenCalled();
      }
    },
  );
});

describe("publish credits from the changelog (a release from commits)", () => {
  // pkg-a's changelog links #31, under 1.0.0 or under an older heading.
  it.each([
    ["1.0.0", [31]],
    ["0.9.0", []],
  ])(
    "credits a linked PR only under the released version's heading (%s)",
    async (heading, credited) => {
      await using fixture = await createPolyglotFixture();
      const cwd = fixture.path;
      await fs.writeFile(
        path.join(cwd, "packages/pkg-a/CHANGELOG.md"),
        `# pkg-a\n\n## ${heading}\n\n### Major Changes\n\n- [#31](https://github.com/changesets/action/pull/31) Node first release\n`,
      );
      await updateGithubContext(cwd);
      vi.stubEnv("RUNNER_TEMP", cwd);

      await runPublish({
        script: `${process.env.SHIPRIG_BIN} tag`,
        github: createGithub(cwd),
        createGithubReleases: false,
        pushGitTags: true,
        commentReleasedPrs: true,
        cwd,
      });

      expect(
        mockedGithubMethods.issues.createComment.mock.calls.map(
          ([arg]) => arg.issue_number,
        ),
      ).toEqual(credited);
    },
  );
});

describe("releaseAs", () => {
  const pkg = (name: string, version: string, bump?: string) =>
    ({
      name,
      version,
      bump,
      nextVersion: bump ? "1.1.0" : undefined,
      ecosystem: "node",
      dir: "/x",
      private: false,
      ignored: false,
      changelog: "/x/CHANGELOG.md",
    }) as ShiprigPackage;

  it("passes an entry for a releasing package below its version", () => {
    expect(
      releaseAsArgs({ a: "2.0.0" }, [pkg("a", "1.0.0", "minor")], undefined),
    ).toEqual(["a=2.0.0"]);
  });

  it("skips a package that isn't releasing, or is already there", () => {
    expect(
      releaseAsArgs(
        { idle: "2.0.0", done: "2.0.0", past: "2.0.0" },
        [
          pkg("idle", "1.0.0"),
          pkg("done", "2.0.0", "minor"),
          pkg("past", "2.1.0", "patch"),
        ],
        undefined,
      ),
    ).toEqual([]);
  });

  it("waits out a prerelease", () => {
    expect(
      releaseAsArgs({ a: "2.0.0" }, [pkg("a", "1.0.0", "minor")], {
        tag: "next",
      }),
    ).toEqual([]);
  });

  it("refuses a package that isn't in the workspace", () => {
    expect(() => releaseAsArgs({ nope: "2.0.0" }, [], undefined)).toThrow(
      "isn't a package in this workspace",
    );
  });

  it("releases the version PR at the exact version", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.list.mockImplementation(() => ({ data: [] }));
    mockedGithubMethods.pulls.create.mockImplementationOnce(() => ({
      data: { number: 123 },
    }));
    await writeChangesets(
      [
        {
          releases: [
            { name: "changesets-dev-simple-project-pkg-a", type: "minor" },
            { name: "changesets-dev-simple-project-pkg-b", type: "minor" },
          ],
          summary: "Awesome feature",
        },
      ],
      cwd,
    );

    await runVersion({
      github: createGithub(cwd),
      cwd,
      releaseAs: { "changesets-dev-simple-project-pkg-a": "3.0.0" },
    });

    const title = mockedGithubMethods.pulls.create.mock.calls[0][0].title;
    expect(title).toContain("3.0.0");
    expect(title).toContain("1.1.0"); // pkg-b keeps its computed minor
  });

  it("refuses releaseAs alongside a custom version script", async () => {
    await using fixture = await createSimpleProjectFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    await expect(
      runVersion({
        github: createGithub(cwd),
        cwd,
        script: "echo custom",
        releaseAs: { "changesets-dev-simple-project-pkg-a": "3.0.0" },
      }),
    ).rejects.toThrow("can't be combined with a custom version-script");
  });
});

describe("separatePullRequests", () => {
  // Release groups arrive with shiprig 1.22.0 (`version --only`); against an
  // older pin the per-group runs can't happen, and the action says why.
  const hasGroups = execFileSync(
    process.env.SHIPRIG_BIN!,
    ["version", "--help"],
    { encoding: "utf8" },
  ).includes("--only");
  // Three packages with no links between them: a and b each have a
  // changeset; c has none.
  function createIndependentFixture() {
    const pkg = (name: string) => JSON.stringify({ name, version: "1.0.0" });
    return gitdir({
      node_modules: (api) => api.symlink(nodeModulesDir),
      ".changeset/config.json": JSON.stringify({}),
      "packages/a/package.json": pkg("@acme/a"),
      "packages/b/package.json": pkg("b"),
      "packages/c/package.json": pkg("c"),
      ".changeset/a-change.md": '---\n"@acme/a": minor\n---\n\nA feature\n',
      ".changeset/b-change.md": '---\n"b": patch\n---\n\nA fix\n',
      "package.json": JSON.stringify({
        name: "independent",
        version: "1.0.0",
        private: true,
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
    });
  }

  const ownPr = (number: number, ref: string, labels: string[] = []) => ({
    number,
    head: { ref, repo: { full_name: "changesets/action" } },
    labels: labels.map((name) => ({ name })),
  });

  it("slugs a group name into a branch segment", () => {
    expect(branchSlug("@acme/lib")).toBe("acme-lib");
    expect(branchSlug("plain")).toBe("plain");
    expect(branchSlug("a..b")).toBe("a.b");
    expect(branchSlug("@@")).toBe("group");
    expect(branchSlug("x.lock")).toBe("x-lock");
  });

  it.runIf(hasGroups)("opens a version PR per release group", async () => {
    await using fixture = await createIndependentFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    mockedGithubMethods.pulls.create
      .mockImplementationOnce(() => ({ data: { number: 11 } }))
      .mockImplementationOnce(() => ({ data: { number: 12 } }));

    const result = await runVersion({
      github: createGithub(cwd),
      cwd,
      separatePullRequests: true,
    });

    const created = mockedGithubMethods.pulls.create.mock.calls.map(
      (c) => c[0] as { head: string; title: string },
    );
    expect(created.map((c) => c.head)).toEqual([
      "changeset-release/some-branch/acme-a",
      "changeset-release/some-branch/b",
    ]);
    // Each PR versions only its group.
    expect(created[0].title).toContain("1.1.0");
    expect(created[0].title).not.toContain("1.0.1");
    expect(created[1].title).toContain("1.0.1");
    expect(created[1].title).not.toContain("1.1.0");
    expect(result.pullRequestNumbers).toEqual([11, 12]);
    expect(result.pullRequestNumber).toBe(11);
    expect(mockedGithubMethods.pulls.update).not.toHaveBeenCalled();
    // The first group's new changelog didn't follow into the second's branch.
    await expect(
      fs.access(path.join(cwd, "packages/a/CHANGELOG.md")),
    ).rejects.toThrow();
    await fs.access(path.join(cwd, "packages/b/CHANGELOG.md"));
  });

  it.runIf(hasGroups)(
    "closes a version PR whose group has nothing pending, unless it's held",
    async () => {
      await using fixture = await createIndependentFixture();
      const cwd = fixture.path;
      await updateGithubContext(cwd);
      const open = [
        ownPr(1, "changeset-release/some-branch"), // the single PR, from before
        ownPr(2, "changeset-release/some-branch/c"), // c released already
        ownPr(3, "changeset-release/some-branch/gone", ["release:hold"]),
        ownPr(4, "feature"), // not a version PR
        ownPr(6, "changeset-release/some-branch/b"), // b's, still current
        {
          ...ownPr(5, "changeset-release/some-branch/fork"),
          head: {
            ref: "changeset-release/some-branch/fork",
            repo: { full_name: "someone/action" },
          },
        },
      ];
      mockedGithubMethods.pulls.list.mockImplementation(
        (args: { head?: string }) => ({
          // A group's own lookup (by head) finds nothing, so it creates.
          data: args.head === undefined ? open : [],
        }),
      );
      mockedGithubMethods.pulls.create.mockImplementation(() => ({
        data: { number: 20 },
      }));

      await runVersion({
        github: createGithub(cwd),
        cwd,
        separatePullRequests: true,
      });

      const closed = mockedGithubMethods.pulls.update.mock.calls.map(
        (c) => (c[0] as { pull_number: number }).pull_number,
      );
      expect(closed).toEqual([1, 2]);
      expect(
        mockedGithubMethods.issues.createComment.mock.calls.map(
          (c) => c[0].issue_number,
        ),
      ).toEqual([1, 2]);
    },
  );

  it.skipIf(hasGroups)("says which shiprig it needs", async () => {
    await using fixture = await createIndependentFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    await expect(
      runVersion({
        github: createGithub(cwd),
        cwd,
        separatePullRequests: true,
      }),
    ).rejects.toThrow("needs shiprig 1.22.0");
    expect(mockedGithubMethods.pulls.create).not.toHaveBeenCalled();
  });

  it("refuses a custom version script", async () => {
    await using fixture = await createIndependentFixture();
    const cwd = fixture.path;
    await updateGithubContext(cwd);
    await expect(
      runVersion({
        github: createGithub(cwd),
        cwd,
        script: "echo custom",
        separatePullRequests: true,
      }),
    ).rejects.toThrow("version-script");
  });
});

describe("releaseTitle", () => {
  it("names one shared version once", () => {
    expect(releaseTitle([{ name: "tool", version: "1.2.0" }])).toBe(
      "chore: release 1.2.0",
    );
    expect(
      releaseTitle([
        { name: "@acme/core", version: "2.0.0" },
        { name: "@acme/cli", version: "2.0.0" },
      ]),
    ).toBe("chore: release 2.0.0");
  });

  it("names up to three packages at different versions, sorted, with short names", () => {
    expect(
      releaseTitle([
        { name: "github.com/acme/tool/ui", version: "0.5.0" },
        { name: "github.com/acme/tool", version: "1.2.0" },
        { name: "@acme/cli", version: "3.0.0" },
      ]),
    ).toBe("chore: release @acme/cli@3.0.0, tool@1.2.0, ui@0.5.0");
  });

  it("keeps full names where short names would collide", () => {
    expect(
      releaseTitle([
        { name: "github.com/a/x/ui", version: "1.0.0" },
        { name: "github.com/b/y/ui", version: "2.0.0" },
        { name: "github.com/a/x", version: "3.0.0" },
      ]),
    ).toBe(
      "chore: release github.com/a/x/ui@1.0.0, github.com/b/y/ui@2.0.0, x@3.0.0",
    );
  });

  it("counts more than three", () => {
    expect(
      releaseTitle(
        ["a", "b", "c", "d"].map((name, i) => ({ name, version: `1.${i}.0` })),
      ),
    ).toBe("chore: release 4 packages");
  });

  it("falls back to the bare prefix when nothing changed", () => {
    expect(releaseTitle([])).toBe("chore: release");
  });
});

describe("publishDecision", () => {
  function github(merged: boolean) {
    return { isVersionPrMerge: vi.fn(() => Promise.resolve(merged)) };
  }

  it("publishes the push that merges the version PR", async () => {
    const gh = github(true);
    const d = await publishDecision({
      github: gh,
      publishOn: "version-pr-merge",
      eventName: "push",
      base: "main",
    });
    expect(d.publish).toBe(true);
    expect(gh.isVersionPrMerge).toHaveBeenCalledWith(
      "changeset-release/main",
      "main",
    );
  });

  it("skips any other push", async () => {
    const d = await publishDecision({
      github: github(false),
      publishOn: "version-pr-merge",
      eventName: "push",
      base: "main",
    });
    expect(d).toMatchObject({ publish: false });
    expect(d.reason).toContain("isn't the merge of the version PR");
    expect(d.reason).toContain("if the workflow allows one");
  });

  it("always publishes a run started by hand", async () => {
    const gh = github(false);
    const d = await publishDecision({
      github: gh,
      publishOn: "version-pr-merge",
      eventName: "workflow_dispatch",
      base: "main",
    });
    expect(d.publish).toBe(true);
    expect(gh.isVersionPrMerge).not.toHaveBeenCalled();
  });

  it.each(["schedule", "pull_request", "workflow_run"])(
    "doesn't publish a %s run",
    async (eventName) => {
      const gh = github(true);
      const d = await publishDecision({
        github: gh,
        publishOn: "version-pr-merge",
        eventName,
        base: "main",
      });
      expect(d.publish).toBe(false);
      expect(gh.isVersionPrMerge).not.toHaveBeenCalled();
    },
  );

  it("publishes on every push with every-push", async () => {
    const d = await publishDecision({
      github: github(false),
      publishOn: "every-push",
      eventName: "push",
      base: "main",
    });
    expect(d.publish).toBe(true);
  });

  it("rejects an unknown publish-on", async () => {
    await expect(
      publishDecision({
        github: github(true),
        publishOn: "sometimes",
        eventName: "push",
        base: "main",
      }),
    ).rejects.toThrow("Invalid publish-on: sometimes");
  });
});
