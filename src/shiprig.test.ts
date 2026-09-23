import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasChangesetFiles,
  readChangelog,
  readPreState,
  readReleasePlan,
  type ShiprigPackage,
} from "./shiprig.ts";
import { gitdir } from "./test-utils.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

function workspace(extra: Record<string, string> = {}) {
  return gitdir({
    ".changeset/config.json": JSON.stringify({}),
    "package.json": JSON.stringify({
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "",
    "packages/pkg-a/package.json": JSON.stringify({
      name: "pkg-a",
      version: "1.0.0",
    }),
    ...extra,
  });
}

describe("readReleasePlan", () => {
  it("is empty when nothing is pending", async () => {
    await using fixture = await workspace();
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    expect(await readReleasePlan(fixture.path)).toEqual([]);
  });

  it("lists what would release", async () => {
    await using fixture = await workspace({
      ".changeset/cs.md": '---\n"pkg-a": minor\n---\n\nA feature\n',
    });
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    expect(await readReleasePlan(fixture.path)).toEqual([
      { name: "pkg-a", type: "minor", newVersion: "1.1.0" },
    ]);
  });

  it("throws when status fails, rather than reading it as nothing pending", async () => {
    await using fixture = await workspace({
      "fake-shiprig": '#!/bin/sh\necho "boom" >&2\nexit 1\n',
    });
    await fs.chmod(path.join(fixture.path, "fake-shiprig"), 0o755);
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    vi.stubEnv("SHIPRIG_BIN", path.join(fixture.path, "fake-shiprig"));
    await expect(readReleasePlan(fixture.path)).rejects.toThrow(
      /shiprig status.*exited with code 1[\s\S]*boom/,
    );
  });
});

describe("readChangelog", () => {
  it("reads only the package's section of a shared (stackspace) changelog", async () => {
    await using fixture = await gitdir({
      "CHANGELOG.md":
        "# Root\n\n## 1.0.1\n\n- Root changed\n\n# Lib\n\n## 1.0.1\n\n- Lib changed\n",
    });
    const pkg = (name: string): ShiprigPackage => ({
      name,
      ecosystem: "dotnet",
      dir: fixture.path,
      version: "1.0.1",
      private: false,
      ignored: false,
      changelog: path.join(fixture.path, "CHANGELOG.md"),
      changelogSection: name,
    });

    const lib = await readChangelog(pkg("Lib"));
    expect(lib).toContain("Lib changed");
    expect(lib).not.toContain("Root changed");
    const root = await readChangelog(pkg("Root"));
    expect(root).toContain("Root changed");
    expect(root).not.toContain("Lib changed");
  });

  it("is undefined when there is no changelog", async () => {
    await using fixture = await gitdir({ "README.md": "hi\n" });
    expect(
      await readChangelog({
        name: "x",
        ecosystem: "node",
        dir: fixture.path,
        version: "1.0.0",
        private: false,
        ignored: false,
        changelog: path.join(fixture.path, "CHANGELOG.md"),
      }),
    ).toBeUndefined();
  });
});

describe("changeset files and pre state", () => {
  it("counts changeset files but not the README", async () => {
    await using bare = await workspace({ ".changeset/README.md": "docs\n" });
    expect(await hasChangesetFiles(bare.path)).toBe(false);
    await using pending = await workspace({
      ".changeset/empty.md": "---\n---\n",
    });
    expect(await hasChangesetFiles(pending.path)).toBe(true);
  });

  it("reads the v3 pre.json", async () => {
    await using fixture = await workspace({
      ".changeset/pre.json": JSON.stringify({ mode: "pre", tag: "next" }),
    });
    expect(await readPreState(fixture.path)).toEqual({
      mode: "pre",
      tag: "next",
    });
    await using none = await workspace();
    expect(await readPreState(none.path)).toBeUndefined();
  });
});
