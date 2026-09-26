import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  planSummary,
  publishedSummary,
  reasonSummary,
  writeSummary,
} from "./summary.ts";

vi.mock("@actions/github", () => ({
  context: { repo: { owner: "acme", repo: "widgets" } },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("summaries", () => {
  it("shows the plan and links the version PR", () => {
    const md = planSummary(
      [
        { name: "pkg-b", type: "patch", newVersion: "2.0.1" },
        { name: "pkg-a", type: "minor", newVersion: "1.1.0" },
      ],
      "https://github.com",
      12,
    );
    expect(md).toContain(
      "The version PR [#12](https://github.com/acme/widgets/pull/12) releases:",
    );
    expect(md.indexOf("`pkg-a`")).toBeLessThan(md.indexOf("`pkg-b`"));
    expect(md).toContain("| `pkg-a` | minor | 1.1.0 |");
  });

  it("links a version PR per group, and says which group each package is in", () => {
    const md = planSummary(
      [
        { name: "b", type: "patch", newVersion: "1.0.1", group: "b" },
        { name: "a", type: "minor", newVersion: "1.1.0", group: "a" },
      ],
      "https://github.com",
      [11, 12],
    );
    expect(md).toContain(
      "A version PR per release group ([#11](https://github.com/acme/widgets/pull/11), [#12](https://github.com/acme/widgets/pull/12)) releases:",
    );
    expect(md).toContain("| Package | Bump | Version | Group |");
    expect(md).toContain("| `a` | minor | 1.1.0 | a |");
  });

  it("keeps the plain table for one PR, even with groups", () => {
    const md = planSummary(
      [{ name: "a", type: "minor", newVersion: "1.1.0", group: "a" }],
      "https://github.com",
      [11],
    );
    expect(md).toContain("The version PR [#11]");
    expect(md).toContain("| `a` | minor | 1.1.0 |\n");
  });

  it("lists what was published, or says nothing was", () => {
    expect(
      publishedSummary([{ name: "widgets", version: "1.2.0", tag: "v1.2.0" }]),
    ).toContain("| `widgets` | 1.2.0 | `v1.2.0` |");
    expect(publishedSummary([])).toContain("Nothing new was released.");
  });

  it("says why a run did nothing", () => {
    expect(reasonSummary("Held.")).toContain("Held.");
  });
});

describe("publishedSummary on a failed publish", () => {
  it("says the command failed, with or without releases", () => {
    const none = publishedSummary([], 1);
    expect(none).toContain("exited with code 1");
    expect(none).toContain("Nothing new was released.");
    const some = publishedSummary(
      [{ name: "widgets", version: "1.2.0", tag: "v1.2.0" }],
      2,
    );
    expect(some).toContain("exited with code 2");
    expect(some).toContain("`v1.2.0`");
    expect(publishedSummary([], 0)).not.toContain("exited");
  });
});

describe("writeSummary", () => {
  it("appends to the job summary file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-"));
    const file = path.join(dir, "summary.md");
    await fs.writeFile(file, "");
    vi.stubEnv("GITHUB_STEP_SUMMARY", file);

    await writeSummary("## hello\n");

    expect(await fs.readFile(file, "utf8")).toContain("## hello");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("remembers that it wrote, so a failure doesn't write a second summary", async () => {
    vi.resetModules();
    const fresh = await import("./summary.ts");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-"));
    const file = path.join(dir, "summary.md");
    await fs.writeFile(file, "");
    vi.stubEnv("GITHUB_STEP_SUMMARY", file);

    expect(fresh.summaryWritten()).toBe(false);
    await fresh.writeSummary("## hello\n");
    expect(fresh.summaryWritten()).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does nothing outside a GitHub run", async () => {
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    await expect(writeSummary("x")).resolves.toBeUndefined();
  });
});
