import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_KEYS,
  findConfig,
  parseConfig,
  resolveSetting,
  stripJsonc,
} from "./config.ts";
import { gitdir } from "./test-utils.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stripJsonc", () => {
  it("drops line and block comments", () => {
    const text = `{
      // a line comment
      "a": 1, /* a block
      comment */ "b": 2
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 1, b: 2 });
  });

  it("drops trailing commas, also before a comment", () => {
    const text = `{ "a": [1, 2,], "b": { "c": 3, }, // done
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it("leaves strings alone, comment markers, commas and escaped quotes included", () => {
    const value = 'a // b /* c */ d ,} e ,] \\" f';
    const text = `{ "s": "${value}" }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({
      s: 'a // b /* c */ d ,} e ,] " f',
    });
  });

  it("rejects an unterminated block comment", () => {
    expect(() => stripJsonc('{ "a": 1 /* never closed')).toThrow(
      "unterminated /* comment",
    );
  });
});

describe("parseConfig", () => {
  it("reads every key, and ignores $schema", () => {
    const config = parseConfig(
      JSON.stringify({
        $schema: "https://example.com/schema.json",
        prTitle: "Release",
        commitMessage: "Release it",
        prDraft: "create",
        prBaseBranch: "main",
        publishOn: "every-push",
        createGithubReleases: false,
        pushGitTags: true,
        pushWithGitCli: true,
      }),
      "f",
    );
    expect(config).toEqual({
      prTitle: "Release",
      commitMessage: "Release it",
      prDraft: "create",
      prBaseBranch: "main",
      publishOn: "every-push",
      createGithubReleases: false,
      pushGitTags: true,
      pushWithGitCli: true,
    });
  });

  it.each([
    [{ prTitel: "x" }, 'unknown key "prTitel"'],
    [{ prTitle: "" }, '"prTitle" must be a non-empty string'],
    [{ prTitle: "   " }, '"prTitle" must be a non-empty string'],
    [{ pushGitTags: "true" }, '"pushGitTags" must be a boolean'],
    [
      { publishOn: "sometimes" },
      '"publishOn" must be "version-pr-merge" or "every-push"',
    ],
    [{ prDraft: true }, '"prDraft" must be "always" or "create"'],
    [{ toString: "x" }, 'unknown key "toString"'],
    [{ constructor: "x" }, 'unknown key "constructor"'],
    [{ $schema: 1 }, '"$schema" must be a non-empty string'],
    [{ prBaseBranch: " main " }, '"prBaseBranch" can\'t contain whitespace'],
  ])("rejects %j", (value, message) => {
    expect(() => parseConfig(JSON.stringify(value), "f")).toThrow(message);
  });

  it("rejects anything but an object, and names the file", () => {
    expect(() => parseConfig("[]", "the/file.jsonc")).toThrow(
      "the/file.jsonc must hold a JSON object",
    );
    expect(() => parseConfig("{ nope", "the/file.jsonc")).toThrow(
      "the/file.jsonc isn't valid JSON(C)",
    );
  });
});

describe("releaseAs", () => {
  it("reads a map of package names to versions", () => {
    expect(
      parseConfig(
        JSON.stringify({
          releaseAs: { "my-lib": "2.0.0", "@acme/app": "1.0.0-rc.1" },
        }),
        "f",
      ).releaseAs,
    ).toEqual({ "my-lib": "2.0.0", "@acme/app": "1.0.0-rc.1" });
  });

  it.each([
    [["2.0.0"], "must be an object"],
    ["2.0.0", "must be an object"],
    [{ "my-lib": "2.0" }, "must be a semver version"],
    [{ "my-lib": "v2.0.0" }, "must be a semver version"],
    [{ "my-lib": 2 }, "must be a semver version"],
    [{ " ": "2.0.0" }, "empty package name"],
  ])("rejects %j", (value, message) => {
    expect(() =>
      parseConfig(JSON.stringify({ releaseAs: value }), "f"),
    ).toThrow(message);
  });

  it("is file-only: no workflow input", () => {
    expect(CONFIG_KEYS.releaseAs.input).toBeNull();
  });
});

describe("findConfig", () => {
  it("is empty with no file", async () => {
    await using fixture = await gitdir({ "README.md": "" });
    expect(await findConfig(fixture.path)).toEqual({ config: {} });
  });

  it.each([
    ".github/shiprig-action.jsonc",
    ".github/shiprig-action.json",
    ".changeset/shiprig-action.jsonc",
    "shiprig-action.jsonc",
  ])("finds %s", async (file) => {
    await using fixture = await gitdir({
      [file]: '{ "prTitle": "From the file", } // JSONC is fine in .json too',
    });
    const found = await findConfig(fixture.path);
    expect(found.config).toEqual({ prTitle: "From the file" });
    expect(await fs.realpath(found.path!)).toBe(
      await fs.realpath(path.join(fixture.path, file)),
    );
  });

  it("looks in .github/ at the repository root when running in a subdirectory", async () => {
    await using fixture = await gitdir({
      ".github/shiprig-action.jsonc": '{ "prTitle": "Root" }',
      "packages/app/.changeset/config.json": "{}",
    });
    const found = await findConfig(path.join(fixture.path, "packages/app"));
    expect(found.config).toEqual({ prTitle: "Root" });
  });

  it("finds .changeset/ at the workspace root from a nested cwd", async () => {
    await using fixture = await gitdir({
      ".changeset/shiprig-action.jsonc": '{ "prTitle": "Workspace" }',
      ".changeset/config.json": "{}",
      "packages/app/package.json": "{}",
    });
    const found = await findConfig(path.join(fixture.path, "packages/app"));
    expect(found.config).toEqual({ prTitle: "Workspace" });
  });

  it("refuses more than one, naming each", async () => {
    await using fixture = await gitdir({
      ".github/shiprig-action.jsonc": "{}",
      ".changeset/shiprig-action.json": "{}",
    });
    await expect(findConfig(fixture.path)).rejects.toThrow(
      /More than one shiprig-action config file[\s\S]*\.github[\s\S]*\.changeset/,
    );
  });
});

describe("resolveSetting", () => {
  it("takes the input over the file", () => {
    vi.stubEnv("INPUT_PR-TITLE", "From the input");
    expect(resolveSetting({ prTitle: "From the file" }, "prTitle")).toBe(
      "From the input",
    );
  });

  it("takes the file when the input is unset", () => {
    expect(resolveSetting({ prTitle: "From the file" }, "prTitle")).toBe(
      "From the file",
    );
    expect(resolveSetting({ pushGitTags: false }, "pushGitTags")).toBe(false);
  });

  it("is undefined with neither, leaving the default to the caller", () => {
    expect(resolveSetting({}, "publishOn")).toBeUndefined();
  });

  it("reads a boolean input the way core.getBooleanInput does", () => {
    vi.stubEnv("INPUT_PUSH-GIT-TAGS", "False");
    expect(resolveSetting({ pushGitTags: true }, "pushGitTags")).toBe(false);
    vi.stubEnv("INPUT_PUSH-GIT-TAGS", "yes");
    expect(() => resolveSetting({}, "pushGitTags")).toThrow(
      'Input "push-git-tags" must be true or false',
    );
  });

  it("checks an enum input", () => {
    vi.stubEnv("INPUT_PUBLISH-ON", "sometimes");
    expect(() => resolveSetting({}, "publishOn")).toThrow(
      'Input "publish-on" must be "version-pr-merge" or "every-push"',
    );
  });
});

// The published schema and the validator describe the same file.
describe("schema/shiprig-action.json", () => {
  it("has the same keys, types and values as the validator", async () => {
    const schema = JSON.parse(
      await fs.readFile(
        path.join(import.meta.dirname, "..", "schema", "shiprig-action.json"),
        "utf8",
      ),
    );
    const props = schema.properties as Record<
      string,
      { type?: string; enum?: string[]; pattern?: string }
    >;
    expect(Object.keys(props).sort()).toEqual(
      ["$schema", ...Object.keys(CONFIG_KEYS)].sort(),
    );
    for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
      if (Array.isArray(spec.type)) {
        expect(props[key].enum, key).toEqual(spec.type);
      } else if (spec.type === "versions") {
        // A map of package names to versions.
        expect(props[key].type, key).toBe("object");
      } else {
        expect(props[key].type, key).toBe(spec.type);
        // A string the validator rejects as blank, the schema rejects too.
        if (spec.type === "string") {
          expect(props[key].pattern, key).toBeDefined();
        }
      }
    }
    expect(schema.additionalProperties).toBe(false);
  });
});
