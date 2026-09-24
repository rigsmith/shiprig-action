import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "tinyexec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitdir } from "../test-utils.ts";
import { getMode } from "./mode.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

// A Go module: released by its git tag, so its publish plan needs no
// registry, only whether the tag is there.
function goModule(extra: Record<string, string> = {}) {
  return gitdir({
    ".changeset/config.json": "{}",
    "go.mod": "module example.com/tool\n\ngo 1.22\n",
    "main.go": "package main\n\nfunc main() {}\n",
    ...extra,
  });
}

describe("select-mode", () => {
  it("versions when a release is pending", async () => {
    await using fixture = await goModule({
      ".changeset/one.md": '---\n"example.com/tool": minor\n---\n\nA feature\n',
    });
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    expect(await getMode(fixture.path)).toEqual({ mode: "version" });
  });

  it("does nothing for changesets that release nothing", async () => {
    await using fixture = await goModule({
      ".changeset/empty.md": "---\n---\n\nNothing to release\n",
    });
    vi.stubEnv("RUNNER_TEMP", fixture.path);
    expect(await getMode(fixture.path)).toEqual({ mode: "none" });
  });

  it("publishes what the publish plan lists, and nothing once it's done", async () => {
    await using fixture = await goModule();
    const cwd = fixture.path;
    vi.stubEnv("RUNNER_TEMP", cwd);

    // The module's tag is missing: shiprig publish-plan lists it tag-only.
    const mode = await getMode(cwd);
    expect(mode.mode).toBe("publish");
    const plan = JSON.parse(
      await fs.readFile(
        (mode as { publishPlanPath: string }).publishPlanPath,
        "utf8",
      ),
    );
    expect(plan.version).toBe(1);
    expect(plan.plan.flat()).toEqual([
      expect.objectContaining({ kind: "tag-only", name: "example.com/tool" }),
    ]);

    // Tagged, there's nothing left to publish.
    const version = JSON.parse(
      (
        await exec(process.env.SHIPRIG_BIN!, ["packages", "list", "--json"], {
          nodeOptions: { cwd },
        })
      ).stdout,
    ).packages[0].version;
    await exec("git", ["tag", `v${version}`], {
      nodeOptions: { cwd },
      throwOnError: true,
    });
    expect(await getMode(cwd)).toEqual({ mode: "none" });
  });
});
