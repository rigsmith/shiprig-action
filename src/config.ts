import fs from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";
import { isSemver, workspaceRoot } from "./shiprig.ts";

// shiprig-action.jsonc (or .json): the action's settings in a committed file,
// as release-please keeps its settings in release-please-config.json. It holds
// the action's own options, not shiprig's release pipeline (that's shiprig's
// release.jsonc / shiprig.jsonc). An input set in the workflow wins over the
// file, and the file over the built-in default.

export const CONFIG_NAME = "shiprig-action";

export type ActionConfig = {
  prTitle?: string;
  commitMessage?: string;
  prDraft?: "always" | "create";
  prBaseBranch?: string;
  publishOn?: "version-pr-merge" | "every-push";
  createGithubReleases?: boolean;
  pushGitTags?: boolean;
  pushWithGitCli?: boolean;
  commentReleasedPrs?: boolean;
  holdLabel?: string;
  // Package name → the exact version to release it at. File-only.
  releaseAs?: Record<string, string>;
};

// Each key, its type, and the input it stands in for.
export const CONFIG_KEYS = {
  prTitle: { type: "string", input: "pr-title" },
  commitMessage: { type: "string", input: "commit-message" },
  prDraft: { type: ["always", "create"], input: "pr-draft" },
  prBaseBranch: { type: "string", input: "pr-base-branch" },
  publishOn: { type: ["version-pr-merge", "every-push"], input: "publish-on" },
  createGithubReleases: { type: "boolean", input: "create-github-releases" },
  pushGitTags: { type: "boolean", input: "push-git-tags" },
  pushWithGitCli: { type: "boolean", input: "push-with-git-cli" },
  commentReleasedPrs: { type: "boolean", input: "comment-released-prs" },
  holdLabel: { type: "string", input: "hold-label" },
  // A map has no single-line input form, so it's set in the file only.
  releaseAs: { type: "versions", input: null },
} as const satisfies Record<
  keyof ActionConfig,
  | { type: "string" | "boolean" | readonly string[]; input: string }
  | { type: "versions"; input: null }
>;

/**
 * Where the file may be: `.github/` at the repository root, `.changeset/` (at
 * the workspace root, found the way shiprig finds it, walking up from `cwd`),
 * or the directory the action runs in. More than one is an error that names
 * them all, never a merge, so there's no question of which one won.
 */
export async function findConfig(
  cwd: string,
): Promise<{ config: ActionConfig; path?: string }> {
  const dirs = [
    ...new Set([
      path.join(await gitRoot(cwd), ".github"),
      path.join(await workspaceRoot(cwd), ".changeset"),
      cwd,
    ]),
  ];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const ext of [".jsonc", ".json"]) {
      const file = path.join(dir, CONFIG_NAME + ext);
      try {
        if ((await fs.stat(file)).isFile()) found.push(file);
      } catch {
        // not there
      }
    }
  }
  if (found.length === 0) {
    return { config: {} };
  }
  if (found.length > 1) {
    throw new Error(
      `More than one ${CONFIG_NAME} config file; keep one:\n${found.map((f) => `  ${f}`).join("\n")}`,
    );
  }
  const file = found[0];
  return {
    config: parseConfig(await fs.readFile(file, "utf8"), file),
    path: file,
  };
}

async function gitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await getExecOutput(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, silent: true },
    );
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

/** Parses and validates the file's text; `file` names it in errors. */
export function parseConfig(text: string, file: string): ActionConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`${file} isn't valid JSON(C): ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} must hold a JSON object`);
  }
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `${file}: "$schema" must be a non-empty string, not ${JSON.stringify(value)}`,
        );
      }
      continue;
    }
    // An own key only: `toString` and the like are unknown keys, not
    // Object.prototype members.
    const spec = Object.hasOwn(CONFIG_KEYS, key)
      ? (CONFIG_KEYS as Record<string, { type: unknown }>)[key]
      : undefined;
    if (!spec) {
      throw new Error(
        `${file}: unknown key "${key}" (known: ${Object.keys(CONFIG_KEYS).join(", ")})`,
      );
    }
    const type = spec.type;
    if (type === "versions") {
      config[key] = parseVersions(value, key, file);
      continue;
    }
    const ok = Array.isArray(type)
      ? typeof value === "string" && type.includes(value)
      : type === "string"
        ? typeof value === "string" && value.trim() !== ""
        : typeof value === type;
    if (!ok) {
      const want = Array.isArray(type)
        ? type.map((t) => JSON.stringify(t)).join(" or ")
        : type === "string"
          ? "a non-empty string"
          : `a ${type}`;
      throw new Error(
        `${file}: "${key}" must be ${want}, not ${JSON.stringify(value)}`,
      );
    }
    // A branch name can't hold whitespace, and " main " would name a base
    // that doesn't exist.
    if (key === "prBaseBranch" && /\s/.test(value as string)) {
      throw new Error(
        `${file}: "prBaseBranch" can't contain whitespace, not ${JSON.stringify(value)}`,
      );
    }
    config[key] = value;
  }
  return config as ActionConfig;
}

/**
 * JSON with comments (`//`, `/* *\/`) and trailing commas, as `tsconfig.json`
 * and the `.changeset` files allow, turned into plain JSON. Strings are copied
 * as they are, so a `//`, a `/*` or a `,}` inside one is left alone.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipComment(text, i);
    } else if (c === ",") {
      // A trailing comma: the next thing that isn't space or a comment closes
      // the object or array.
      const next = text[skipSpace(text, i + 1)];
      if (next !== "}" && next !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// The index just past the comment starting at i.
function skipComment(text: string, i: number): number {
  if (text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end;
  }
  const end = text.indexOf("*/", i + 2);
  if (end === -1) throw new Error("unterminated /* comment");
  return end + 2;
}

// The index of the next character that isn't whitespace or inside a comment.
function skipSpace(text: string, i: number): number {
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
    } else if (
      text[i] === "/" &&
      (text[i + 1] === "/" || text[i + 1] === "*")
    ) {
      i = skipComment(text, i);
    } else {
      break;
    }
  }
  return i;
}

/**
 * The value for one setting: the input when the workflow sets it, else the
 * file's, else undefined for the caller's own default. Boolean inputs take
 * YAML's true/false spellings, as `core.getBooleanInput` does.
 */
// A `versions` value: an object from package name to a strict semver
// version.
function parseVersions(
  value: unknown,
  key: string,
  file: string,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${file}: "${key}" must be an object of package names to versions, not ${JSON.stringify(value)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (name.trim() === "") {
      throw new Error(`${file}: "${key}" has an empty package name`);
    }
    if (typeof version !== "string" || !isSemver(version)) {
      throw new Error(
        `${file}: "${key}"."${name}" must be a semver version like "2.0.0", not ${JSON.stringify(version)}`,
      );
    }
    out[name] = version;
  }
  return out;
}

export function resolveSetting<K extends keyof ActionConfig>(
  config: ActionConfig,
  key: K,
): ActionConfig[K] | undefined {
  const spec = CONFIG_KEYS[key];
  if (spec.input === null) return config[key];
  const input = core.getInput(spec.input);
  if (input !== "") {
    if (spec.type === "boolean") {
      if (["true", "True", "TRUE"].includes(input))
        return true as ActionConfig[K];
      if (["false", "False", "FALSE"].includes(input))
        return false as ActionConfig[K];
      throw new TypeError(
        `Input "${spec.input}" must be true or false, not ${JSON.stringify(input)}`,
      );
    }
    if (Array.isArray(spec.type) && !spec.type.includes(input)) {
      throw new TypeError(
        `Input "${spec.input}" must be ${spec.type.map((t: string) => JSON.stringify(t)).join(" or ")}, not ${JSON.stringify(input)}`,
      );
    }
    return input as ActionConfig[K];
  }
  return config[key];
}

/** Finds the config file (logging which one) and returns it for resolveSetting. */
export async function loadConfig(cwd: string): Promise<ActionConfig> {
  const { config, path: file } = await findConfig(cwd);
  if (file) core.info(`Using settings from ${file}`);
  return config;
}
