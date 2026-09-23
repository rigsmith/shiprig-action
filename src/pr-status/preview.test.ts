import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "tinyexec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readReleasePlan } from "../shiprig.ts";
import { gitdir } from "../test-utils.ts";
import {
  getAbsentMessage,
  getApproveMessage,
  getStatusMessage,
} from "./message.ts";
import {
  pullRequestChangesets,
  changedPackages,
  changelogMarkdown,
  previewChangelog,
  versionsFromChangesetsOnly,
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
    const preview = await previewChangelog(fixture.path, [
      ".changeset/pr-one.md",
    ]);
    expect(preview).toContain("### pkg-b");
    expect(preview).toContain("#### 1.1.0");
    expect(preview).toContain("The PR adds a feature");
    expect(preview).not.toContain("Already on main");
    expect(preview).not.toContain("pkg-a");
    // the README and the pull request's changeset survive
    await expect(
      fs.access(path.join(fixture.path, ".changeset/README.md")),
    ).resolves.toBeUndefined();
  });
});

describe("a repository that also versions from commits", () => {
  it("leaves the preview out, since shiprig can't limit it to the PR", async () => {
    await using fixture = await pullRequestRepo();
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);
    // A conventional commit on main, below the pull request's branch.
    await git(cwd, "checkout", "-q", "main");
    await fs.writeFile(
      path.join(cwd, ".changeset/config.json"),
      JSON.stringify({ versioning: { source: "both" } }),
    );
    await fs.writeFile(path.join(cwd, "packages/a/index.js"), "export {};\n");
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-q", "-m", "feat: a thing on main");
    await git(cwd, "checkout", "-q", "feature");
    await git(cwd, "rebase", "-q", "main");

    expect(await versionsFromChangesetsOnly(cwd)).toBe(false);
    const md = await getStatusMessage(cwd, "main", {
      sha: "abc",
      title: "Change b",
      headRepoUrl: "https://github.com/o/r",
      headRef: "feature",
    });
    expect(md).toContain("also versions from conventional commits");
    expect(md).not.toContain("Changelog preview");
  });

  it.each([
    ["{}", true],
    ['{ "versioning": { "source": "changesets" } }', true],
    ['// a comment\n{ "versioning": { "source": "commits" } }', false],
    ["{ not json", false],
  ])("reads the source from %s", async (config, expected) => {
    await using fixture = await pullRequestRepo();
    await fs.writeFile(
      path.join(fixture.path, ".changeset/config.json"),
      config,
    );
    expect(await versionsFromChangesetsOnly(fixture.path)).toBe(expected);
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
