import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "tinyexec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readReleasePlan } from "../shiprig.ts";
import { gitdir } from "../test-utils.ts";
import {
  getAbsentMessage,
  getApproveMessage,
  getStatus,
  getStatusMessage,
  getUnreleasedMessage,
} from "./message.ts";
import {
  pullRequestChangesets,
  changedPackages,
  changesetPackageNames,
  changelogMarkdown,
  previewChangelog,
  versioningSource,
} from "./preview.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function git(cwd: string, ...args: string[]) {
  await exec("git", args, { nodeOptions: { cwd }, throwOnError: true });
}

// main has one pending changeset (pkg-a); the pull request's branch adds its
// own (pkg-b) and changes pkg-b's code.
async function pullRequestRepo() {
  const fixture = await gitdir({
    ".changeset/config.json": "{}",
    ".changeset/README.md": "# Changesets\n",
    ".changeset/main-one.md": '---\n"pkg-a": patch\n---\n\nAlready on main\n',
    "package.json": JSON.stringify({
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "",
    "packages/a/package.json": JSON.stringify({
      name: "pkg-a",
      version: "1.0.0",
    }),
    "packages/b/package.json": JSON.stringify({
      name: "pkg-b",
      version: "1.0.0",
    }),
    "packages/b/index.js": "export {};\n",
  });
  const cwd = fixture.path;
  await git(cwd, "checkout", "-q", "-b", "feature");
  await fs.writeFile(
    path.join(cwd, ".changeset/pr-one.md"),
    '---\n"pkg-b": minor\n---\n\nThe PR adds a feature\n',
  );
  await fs.writeFile(
    path.join(cwd, "packages/b/index.js"),
    "export const x = 1;\n",
  );
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", "feature");
  return fixture;
}

describe("pr-status on shiprig", () => {
  it("reads the plan for the pull request's own changesets", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    expect(await readReleasePlan(fixture.path, { since: "main" })).toEqual([
      { name: "pkg-b", type: "minor", newVersion: "1.1.0" },
    ]);
  });

  it("finds the changesets the pull request adds, not main's", async () => {
    await using fixture = await pullRequestRepo();
    expect(await pullRequestChangesets(fixture.path, "main")).toEqual([
      ".changeset/pr-one.md",
    ]);
  });

  it("counts a changeset the pull request edits", async () => {
    await using fixture = await pullRequestRepo();
    const cwd = fixture.path;
    await fs.writeFile(
      path.join(cwd, ".changeset/main-one.md"),
      '---\n"pkg-a": minor\n---\n\nEdited in the PR\n',
    );
    await git(cwd, "commit", "-qam", "edit main's changeset");
    expect(await pullRequestChangesets(cwd, "main")).toEqual([
      ".changeset/main-one.md",
      ".changeset/pr-one.md",
    ]);
  });

  it("doesn't count a changeset the pull request deletes", async () => {
    await using fixture = await pullRequestRepo();
    const cwd = fixture.path;
    await git(cwd, "rm", "-q", ".changeset/main-one.md");
    await git(cwd, "commit", "-qm", "drop main's changeset");
    expect(await pullRequestChangesets(cwd, "main")).toEqual([
      ".changeset/pr-one.md",
    ]);
  });

  it("leaves out ignored packages", async () => {
    await using fixture = await pullRequestRepo();
    const cwd = fixture.path;
    await fs.writeFile(
      path.join(cwd, ".changeset/config.json"),
      JSON.stringify({ ignore: ["pkg-b"] }),
    );
    await git(cwd, "commit", "-qam", "ignore pkg-b");
    expect(await changedPackages(cwd, "main")).toEqual([]);
  });

  it("reads unusual path names as they are", async () => {
    await using fixture = await pullRequestRepo();
    const cwd = fixture.path;
    await fs.writeFile(
      path.join(cwd, ".changeset/café-one.md"),
      '---\n"pkg-b": patch\n---\n\nAccented\n',
    );
    await fs.writeFile(path.join(cwd, "packages/a/naïve.js"), "export {};\n");
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-q", "-m", "accents");
    expect(await pullRequestChangesets(cwd, "main")).toEqual([
      ".changeset/café-one.md",
      ".changeset/pr-one.md",
    ]);
    expect(await changedPackages(cwd, "main")).toEqual(["pkg-a", "pkg-b"]);
  });

  it("finds the packages the pull request changes", async () => {
    await using fixture = await pullRequestRepo();
    expect(await changedPackages(fixture.path, "main")).toEqual(["pkg-b"]);
  });

  it("gives a single-package repository's changes to its root package", async () => {
    await using fixture = await gitdir({
      ".changeset/config.json": "{}",
      "package.json": JSON.stringify({ name: "solo", version: "1.0.0" }),
      "package-lock.json": "",
      "src/index.js": "export {};\n",
    });
    const cwd = fixture.path;
    await git(cwd, "checkout", "-q", "-b", "feature");
    await fs.writeFile(path.join(cwd, "src/index.js"), "export const y = 2;\n");
    await git(cwd, "commit", "-qam", "change");
    expect(await changedPackages(cwd, "main")).toEqual(["solo"]);
  });

  it("previews only the pull request's own changelog entries", async () => {
    await using fixture = await pullRequestRepo();
    const preview = await previewChangelog(fixture.path, "main");
    expect(preview).toContain("### pkg-b");
    expect(preview).toContain("#### 1.1.0");
    expect(preview).toContain("The PR adds a feature");
    expect(preview).not.toContain("Already on main");
    expect(preview).not.toContain("pkg-a");
    // `--since` scopes it; nothing in the checkout is touched
    await expect(
      fs.access(path.join(fixture.path, ".changeset/main-one.md")),
    ).resolves.toBeUndefined();
  });
});

// A repository whose versioning.source is commits: releases come from
// conventional commits. main has a feat commit to pkg-a already.
async function commitsRepo(source: "commits" | "both") {
  const fixture = await pullRequestRepo();
  const cwd = fixture.path;
  await git(cwd, "checkout", "-q", "main");
  await fs.writeFile(
    path.join(cwd, ".changeset/config.json"),
    JSON.stringify({ versioning: { source } }),
  );
  await fs.writeFile(path.join(cwd, "packages/a/index.js"), "export {};\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", "feat: a thing on main");
  await git(cwd, "checkout", "-q", "-B", "feature", "main");
  return fixture;
}

const aPullRequest = {
  sha: "abc",
  title: "Change b",
  headRepoUrl: "https://github.com/o/r",
  headRef: "feature",
};

describe("a repository that also versions from commits", () => {
  it("plans and previews only the pull request's share", async () => {
    await using fixture = await commitsRepo("both");
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);
    await fs.writeFile(
      path.join(cwd, ".changeset/pr-one.md"),
      '---\n"pkg-b": minor\n---\n\nThe PR adds a feature\n',
    );
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-q", "-m", "a changeset for b");

    expect(await versioningSource(cwd)).toBe("both");
    const md = await getStatusMessage(cwd, "main", aPullRequest);
    expect(md).toContain("Changeset detected");
    // Changesets and commits can both release here: neither is credited.
    expect(md).toContain("This PR releases 1 package");
    expect(md).toMatch(/\| pkg-b +\| Minor +\| 1\.1\.0 +\|/);
    expect(md).toContain("<summary>Changelog preview</summary>");
    expect(md).toContain("The PR adds a feature");
    // main's commit and changeset are main's, not the PR's
    expect(md).not.toContain("pkg-a");
    expect(md).not.toContain("a thing on main");
    expect(md).not.toContain("Already on main");
  });

  it("shows a release from the pull request's commits, with no changeset", async () => {
    await using fixture = await commitsRepo("commits");
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);
    await fs.writeFile(
      path.join(cwd, "packages/b/index.js"),
      "export const z = 3;\n",
    );
    await git(cwd, "commit", "-qam", "feat: a new thing in b");

    const md = await getStatusMessage(cwd, "main", aPullRequest);
    expect(md).toContain("Release detected");
    expect(md).toContain("This PR's commits release 1 package");
    expect(md).toMatch(/\| pkg-b +\| Minor +\|/);
    expect(md).toContain("a new thing in b");
    expect(md).not.toContain("pkg-a");
  });

  it("says nothing releases when its commits don't", async () => {
    await using fixture = await commitsRepo("commits");
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);
    await fs.writeFile(
      path.join(cwd, "packages/b/index.js"),
      "export const z = 3;\n",
    );
    // No conventional type, so no release (shiprig's default groups release
    // docs: as a patch).
    await git(cwd, "commit", "-qam", "tidy b");

    const md = await getStatusMessage(cwd, "main", aPullRequest);
    // Commits are the only source: the guidance is a releasing commit, and a
    // changeset link would lead nowhere.
    expect(md).toContain("No release found");
    expect(md).toContain("`feat:`");
    expect(md).not.toContain("add a changeset");
  });

  // With commits alone as the source, a changeset releases nothing.
  it("doesn't count a changeset when commits are the only source", async () => {
    await using fixture = await commitsRepo("commits");
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);
    await fs.writeFile(
      path.join(cwd, ".changeset/pr-one.md"),
      '---\n"pkg-b": minor\n---\n\nThe PR adds a feature\n',
    );
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-q", "-m", "a changeset, no releasing commit");

    const md = await getStatusMessage(cwd, "main", aPullRequest);
    expect(md).toContain("No release found");
    expect(md).not.toContain("Changeset detected");
  });

  it("offers either route when both sources release nothing", async () => {
    await using fixture = await commitsRepo("both");
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);
    await fs.writeFile(
      path.join(cwd, "packages/b/index.js"),
      "export const z = 3;\n",
    );
    await git(cwd, "commit", "-qam", "tidy b");

    const md = await getStatusMessage(cwd, "main", aPullRequest);
    expect(md).toContain("No Changeset found");
    expect(md).toContain("add a changeset, or give a commit a releasing");
  });

  it.each([
    ["{}", "changesets"],
    ['{ "versioning": { "source": "changesets" } }', "changesets"],
    ['// a comment\n{ "versioning": { "source": "commits" } }', "commits"],
    ['{ "versioning": { "source": "both" } }', "both"],
    ["{ not json", "both"],
  ])("reads the source from %s", async (config, expected) => {
    await using fixture = await pullRequestRepo();
    await fs.writeFile(
      path.join(fixture.path, ".changeset/config.json"),
      config,
    );
    expect(await versioningSource(fixture.path)).toBe(expected);
  });
});

describe("getStatusMessage", () => {
  const pr = {
    sha: "abc",
    title: "Change b",
    headRepoUrl: "https://github.com/o/r",
    headRef: "feature",
  };

  it("reports the plan and the preview for the pull request's changesets", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    const md = await getStatusMessage(fixture.path, "main", pr);
    expect(md).toContain("Changeset detected");
    expect(md).not.toContain("conventional commits");
    expect(md).toMatch(/\| pkg-b +\| Minor +\| 1\.1\.0 +\|/);
    expect(md).toContain("The PR adds a feature");
    // main's pending changeset is neither planned nor previewed
    expect(md).not.toContain("pkg-a");
    expect(md).not.toContain("Already on main");
  });

  // `status --since` fails when packages changed without a changeset.
  it("says no changeset was found when code changed without one", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await git(fixture.path, "rm", "-q", ".changeset/pr-one.md");
    await git(fixture.path, "commit", "-q", "-m", "drop changeset");
    const md = await getStatusMessage(fixture.path, "main", pr);
    expect(md).toContain("No Changeset found");
    expect(md).toContain(encodeURIComponent('"pkg-b": patch'));
  });
});

describe("changelogMarkdown", () => {
  it("keeps the Markdown, drops the plan and the dry-run note, and demotes headings", () => {
    const stdout = [
      "  minor  pkg-b  1.0.0 → 1.1.0",
      "",
      "# pkg-b",
      "",
      "## 1.1.0",
      "",
      "### Minor Changes",
      "",
      "- The PR adds a feature",
      "                            ",
      "(dry run — no files written)",
    ].join("\n");
    expect(changelogMarkdown(stdout)).toBe(
      [
        "### pkg-b",
        "",
        "#### 1.1.0",
        "",
        "##### Minor Changes",
        "",
        "- The PR adds a feature",
      ].join("\n"),
    );
  });

  it("is undefined when there's no Markdown", () => {
    expect(changelogMarkdown("nothing to release\n")).toBeUndefined();
  });
});

describe("messages", () => {
  it("shows the plan with versions and the changelog preview", () => {
    const md = getApproveMessage(
      "abc",
      "https://x",
      [{ name: "pkg-b", type: "minor", newVersion: "1.1.0" }],
      1,
      "### pkg-b\n\n- The PR adds a feature",
    );
    expect(md).toContain("This PR includes changesets to release 1 package");
    expect(md).toMatch(/\| pkg-b +\| Minor +\| 1\.1\.0 +\|/);
    expect(md).toContain("<summary>Changelog preview</summary>");
    expect(md).toContain("- The PR adds a feature");
  });

  it("leaves the preview out when there is none", () => {
    expect(
      getApproveMessage("abc", "https://x", [], 1, undefined),
    ).not.toContain("Changelog preview");
  });

  it("says when no changeset was found", () => {
    expect(getAbsentMessage("abc", "https://x")).toContain(
      "No Changeset found",
    );
  });
});

describe("changed but not released", () => {
  async function changeA(cwd: string, message = "change a") {
    await fs.writeFile(
      path.join(cwd, "packages/a/index.js"),
      "export const a = 1;\n",
    );
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-q", "-m", message);
  }

  it("names a package the pull request changes that its changeset leaves out", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await changeA(fixture.path);
    const { body, unreleased } = await getStatus(
      fixture.path,
      "main",
      aPullRequest,
    );
    // pkg-b has its changeset; pkg-a changed with none.
    expect(unreleased).toEqual(["pkg-a"]);
    expect(body).toContain("Changeset detected");
    expect(body).toContain("**Changed but not released:** `pkg-a`.");
    expect(body).toContain("`none` if they shouldn't release");
  });

  it("counts a `none` changeset as a decision", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await fs.writeFile(
      path.join(fixture.path, ".changeset/pr-none.md"),
      // Double-quoted: shiprig reads single-quoted names from 1.22.0.
      '---\n"pkg-a": none\n---\n\nNo release for a\n',
    );
    await changeA(fixture.path);
    const { body, unreleased } = await getStatus(
      fixture.path,
      "main",
      aPullRequest,
    );
    expect(unreleased).toEqual([]);
    expect(body).not.toContain("Changed but not released");
  });

  it("names every changed package when there is no changeset", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await git(fixture.path, "rm", "-q", ".changeset/pr-one.md");
    await git(fixture.path, "commit", "-q", "-m", "drop changeset");
    const { body, unreleased } = await getStatus(
      fixture.path,
      "main",
      aPullRequest,
    );
    expect(unreleased).toEqual(["pkg-b"]);
    expect(body).toContain("No Changeset found");
    expect(body).toContain("**Changed but not released:** `pkg-b`.");
  });

  it("says nothing when no package changed", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await git(fixture.path, "reset", "-q", "--hard", "main");
    await fs.writeFile(path.join(fixture.path, "README.md"), "# Docs\n");
    await git(fixture.path, "add", "-A");
    await git(fixture.path, "commit", "-q", "-m", "docs");
    const { body, unreleased } = await getStatus(
      fixture.path,
      "main",
      aPullRequest,
    );
    expect(unreleased).toEqual([]);
    expect(body).toContain("No Changeset found");
    expect(body).not.toContain("Changed but not released");
  });

  it("takes a releasing commit as the release in a repository using both", async () => {
    await using fixture = await commitsRepo("both");
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await fs.writeFile(
      path.join(fixture.path, "packages/b/index.js"),
      "export const z = 3;\n",
    );
    await git(fixture.path, "commit", "-qam", "fix: b");
    await changeA(fixture.path, "tidy a");
    const { body, unreleased } = await getStatus(
      fixture.path,
      "main",
      aPullRequest,
    );
    expect(unreleased).toEqual(["pkg-a"]);
    expect(body).toContain(
      "add a changeset for them, or give a commit a releasing conventional type",
    );
  });

  it("ignores changesets when commits are the only source", async () => {
    await using fixture = await commitsRepo("commits");
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    await fs.writeFile(
      path.join(fixture.path, ".changeset/pr-none.md"),
      '---\n"pkg-a": none\n---\n\nNo release for a\n',
    );
    await changeA(fixture.path, "tidy a");
    const { body, unreleased } = await getStatus(
      fixture.path,
      "main",
      aPullRequest,
    );
    expect(unreleased).toEqual(["pkg-a"]);
    expect(body).toContain("No release found");
    expect(body).toContain("give a commit a releasing conventional type");
    expect(body).not.toContain("add a changeset");
  });

  it("doesn't follow a changeset symlinked out of the checkout", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    try {
      await fs.writeFile(
        path.join(outside, "decides.md"),
        '---\n"pkg-a": none\n---\n\nFrom outside\n',
      );
      await fs.symlink(
        path.join(outside, "decides.md"),
        path.join(fixture.path, ".changeset/link.md"),
      );
      await changeA(fixture.path);
      expect(await pullRequestChangesets(fixture.path, "main")).toContain(
        ".changeset/link.md",
      );
      const { unreleased } = await getStatus(
        fixture.path,
        "main",
        aPullRequest,
      );
      // The link's `none` would have decided pkg-a; it isn't read.
      expect(unreleased).toEqual(["pkg-a"]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("says only some changes release when some don't", async () => {
    await using fixture = await pullRequestRepo();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    const { body: all } = await getStatus(fixture.path, "main", aPullRequest);
    expect(all).toContain(
      "**The changes in this PR will be included in the next version bump.**",
    );
    await changeA(fixture.path);
    const { body: some } = await getStatus(fixture.path, "main", aPullRequest);
    expect(some).toContain(
      "**Some of the changes in this PR will be included in the next version bump.**",
    );
  });

  it("is empty when every changed package is decided", () => {
    expect(getUnreleasedMessage([], "changesets")).toBe("");
    expect(getUnreleasedMessage(["a", "b"], "changesets")).toContain(
      "`a`, `b`. This PR changes these packages",
    );
  });
});

describe("changesetPackageNames", () => {
  it.each([
    ['---\n"@scope/pkg": minor\n---\n\nx\n', ["@scope/pkg"]],
    ["---\n'it''s': patch\n---\n", ["it's"]],
    ["---\nplain-pkg: none\n---\n", ["plain-pkg"]],
    ['---\n"esc\\"aped": patch\n---\n', ['esc"aped']],
    ["---\n# a comment\na: patch # why\n\nb:   major\n---\n", ["a", "b"]],
    ["---\n---\n\nEmpty\n", []],
    // No closing line, or no header at all: not a changeset.
    ["---\na: patch\n", []],
    ["a: patch\n", []],
    // A colon with nothing after it but a word is not a key: value line.
    ["---\nhttp://x: patch\n---\n", []],
    // YAML's double-quoted escapes, beyond JSON's.
    ['---\n"\\x41\\_b": patch\n---\n', ["A\u00a0b"]],
    ['---\n"\\U0001F600": patch\n---\n', ["\u{1F600}"]],
    // A `#` inside a quoted name is part of it, not a comment.
    ['---\n"a#b": patch # why\n---\n', ["a#b"]],
    ["---\n'a # b': patch\n---\n", ["a # b"]],
    // An escape YAML doesn't have is skipped, never thrown.
    ['---\n"\\q": patch\nok: minor\n---\n', ["ok"]],
    ['---\n"\\x4": patch\n---\n', []],
  ])("reads %j", (content, expected) => {
    expect(changesetPackageNames(content)).toEqual(expected);
  });
});
