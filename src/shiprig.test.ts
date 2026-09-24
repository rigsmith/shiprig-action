import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atLeast,
  hasChangesetFiles,
  listPackages,
  readChangelog,
  readPreState,
  readReleasePlan,
  requireShiprig,
  resetShiprigCheck,
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

describe("listPackages fails closed", () => {
  async function withPackagesJson(json: unknown) {
    const fixture = await workspace({
      "fake-shiprig": `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(json)}\nEOF\n`,
    });
    await fs.chmod(path.join(fixture.path, "fake-shiprig"), 0o755);
    vi.stubEnv("SHIPRIG_BIN", path.join(fixture.path, "fake-shiprig"));
    return fixture;
  }
  const good = {
    name: "pkg-a",
    version: "1.0.0",
    ecosystem: "npm",
    dir: "packages/pkg-a",
    changelog: "packages/pkg-a/CHANGELOG.md",
    private: false,
    ignored: false,
  };

  it("reads a well-formed list", async () => {
    await using fixture = await withPackagesJson({ packages: [good] });
    const [pkg] = await listPackages(fixture.path);
    expect(pkg.name).toBe("pkg-a");
    expect(pkg.dir).toBe(path.join(fixture.path, "packages/pkg-a"));
  });

  it.each(["name", "version", "ecosystem", "dir", "changelog"])(
    "throws on a package with an empty %s",
    async (field) => {
      await using fixture = await withPackagesJson({
        packages: [{ ...good, [field]: "" }],
      });
      await expect(listPackages(fixture.path)).rejects.toThrow(
        `reported a package with no ${field}`,
      );
    },
  );

  it("throws on a whitespace-only version", async () => {
    await using fixture = await withPackagesJson({
      packages: [{ ...good, version: "   " }],
    });
    await expect(listPackages(fixture.path)).rejects.toThrow(
      "reported a package with no version",
    );
  });

  it.each(["private", "ignored"])(
    "throws when %s isn't a boolean",
    async (field) => {
      await using fixture = await withPackagesJson({
        packages: [{ ...good, [field]: "false" }],
      });
      await expect(listPackages(fixture.path)).rejects.toThrow(
        `whose ${field} isn't true or false`,
      );
    },
  );

  it("throws when there is no packages list", async () => {
    await using fixture = await withPackagesJson({ pkgs: [] });
    await expect(listPackages(fixture.path)).rejects.toThrow(
      /no "packages" list/,
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

describe("readPreState fails closed", () => {
  it.each([
    ["malformed JSON", "{ not json"],
    ["pre mode without a tag", JSON.stringify({ mode: "pre" })],
    ["a non-string tag", JSON.stringify({ mode: "pre", tag: 1 })],
    ["an unknown mode", JSON.stringify({ mode: "draft", tag: "next" })],
    ["a whitespace-only tag", JSON.stringify({ mode: "pre", tag: " " })],
  ])("throws on %s", async (_, content) => {
    await using fixture = await workspace({ ".changeset/pre.json": content });
    await expect(readPreState(fixture.path)).rejects.toThrow(/pre\.json/);
  });

  it("throws when pre.json exists but can't be read", async () => {
    // A directory where the file should be: exists, unreadable as a file.
    await using fixture = await workspace({ ".changeset/pre.json/x": "" });
    await expect(readPreState(fixture.path)).rejects.toThrow(
      /Could not read .*pre\.json/,
    );
  });

  it("reads exit mode with its tag", async () => {
    await using fixture = await workspace({
      ".changeset/pre.json": JSON.stringify({ mode: "exit", tag: "rc" }),
    });
    expect(await readPreState(fixture.path)).toEqual({
      mode: "exit",
      tag: "rc",
    });
  });
});

describe("hasChangesetFiles and prerelease", () => {
  it("counts the changesets waiting in pre/ once pre exit has run", async () => {
    await using fixture = await workspace({
      ".changeset/pre.json": JSON.stringify({ mode: "exit", tag: "next" }),
      ".changeset/pre/feature.md": '---\n"pkg-a": minor\n---\n\nA feature\n',
    });
    expect(await hasChangesetFiles(fixture.path)).toBe(true);
  });

  it("doesn't count them in pre mode, where they're already released", async () => {
    await using fixture = await workspace({
      ".changeset/pre.json": JSON.stringify({ mode: "pre", tag: "next" }),
      ".changeset/pre/feature.md": '---\n"pkg-a": minor\n---\n\nA feature\n',
    });
    expect(await hasChangesetFiles(fixture.path)).toBe(false);
  });
});

describe("the shiprig version", () => {
  afterEach(() => resetShiprigCheck());

  it("compares versions as semver orders them", () => {
    expect(atLeast("1.21.0", "1.21.0")).toBe(true);
    expect(atLeast("1.21.3", "1.21.0")).toBe(true);
    expect(atLeast("2.0.0", "1.21.0")).toBe(true);
    expect(atLeast("1.20.9", "1.21.0")).toBe(false);
    expect(atLeast("1.21.0-rc.1", "1.21.0")).toBe(false);
    expect(atLeast("1.21.1-rc.1", "1.21.0")).toBe(true);
    expect(atLeast("1.9.0", "1.21.0")).toBe(false); // numbers, not strings
  });

  it("isn't a version when it's a banner", () => {
    expect(atLeast("  ╭─╴ ╶─╮ shipRig v1.20.3", "1.21.0")).toBe(false);
  });

  it("accepts the pinned shiprig", async () => {
    await expect(requireShiprig()).resolves.toBeUndefined();
  });

  // A script standing in for shiprig prints what the given release would.
  async function fakeShiprig(dir: string, stdout: string) {
    const bin = path.join(dir, "shiprig");
    await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, {
      mode: 0o755,
    });
    vi.stubEnv("SHIPRIG_BIN", bin);
  }

  it.skipIf(process.platform === "win32")(
    "refuses an older shiprig, banner or version",
    async () => {
      await using fixture = await workspace();
      await fakeShiprig(fixture.path, "  shipRig  v1.20.3 (abc1234)");
      await expect(requireShiprig()).rejects.toThrow(
        /needs shiprig 1\.21\.0 or later.*isn't a bare version/,
      );
      resetShiprigCheck();
      await fakeShiprig(fixture.path, "1.20.3");
      await expect(requireShiprig()).rejects.toThrow(/found shiprig 1\.20\.3/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "lets a source build through",
    async () => {
      await using fixture = await workspace();
      await fakeShiprig(
        fixture.path,
        "source build · 2026-09-24 · /src/rigsmith",
      );
      await expect(requireShiprig()).resolves.toBeUndefined();
    },
  );
});
