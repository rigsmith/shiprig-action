import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommentOctokit,
  commentBody,
  commentReleasedPrs,
  namesPackage,
} from "./releasedComments.ts";

vi.mock("@actions/github", () => ({
  context: { repo: { owner: "acme", repo: "widgets" } },
}));
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  info: vi.fn(),
  warning: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const SERVER = "https://github.com";

// A repository as the API sees it: the release commit's removed files, each
// changeset's text at the parent, the commit that added it, and that commit's
// pull request.
function fakeGitHub(opts: {
  removed: string[];
  changesets: Record<string, string>;
  addedBy: Record<string, number>; // changeset path -> pull request
  existingComments?: Record<number, string[]>;
  failComment?: number;
}) {
  const created: { pr: number; body: string }[] = [];
  const octokit: CommentOctokit = {
    rest: {
      repos: {
        getCommit: async () => ({
          data: {
            parents: [{ sha: "parent" }],
            files: opts.removed.map((filename) => ({
              filename,
              status: "removed",
            })),
          },
        }),
        getContent: async ({ path }) => ({
          data: {
            content: Buffer.from(opts.changesets[path] ?? "").toString(
              "base64",
            ),
          },
        }),
        listCommits: async ({ path }) => ({
          // newest first; the last is the commit that added the file
          data: [{ sha: `edit-of-${path}` }, { sha: `add-of-${path}` }],
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          const path = commit_sha.replace(/^add-of-/, "");
          const pr = opts.addedBy[path];
          return {
            data:
              commit_sha.startsWith("add-of-") && pr !== undefined
                ? [{ number: pr, merged_at: "2026-09-23T00:00:00Z" }]
                : [],
          };
        },
      },
      issues: {
        listComments: async ({ issue_number }) => ({
          data: (opts.existingComments?.[issue_number] ?? []).map((body) => ({
            body,
          })),
        }),
        createComment: async ({ issue_number, body }) => {
          if (issue_number === opts.failComment) {
            throw new Error("Resource not accessible by integration");
          }
          created.push({ pr: issue_number, body });
          return {};
        },
      },
    },
  };
  return { octokit, created };
}

const cs = (frontmatter: string) => `---\n${frontmatter}\n---\n\nA change\n`;

describe("commentReleasedPrs", () => {
  it("comments on the pull request that added each consumed changeset", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/brave-owls.md"],
      changesets: { ".changeset/brave-owls.md": cs('"widgets": minor') },
      addedBy: { ".changeset/brave-owls.md": 42 },
    });

    const commented = await commentReleasedPrs({
      octokit,
      sha: "release-sha",
      released: [{ name: "widgets", version: "1.2.0", tag: "v1.2.0" }],
      serverUrl: SERVER,
    });

    expect(commented).toEqual([42]);
    expect(created).toHaveLength(1);
    expect(created[0].body).toContain(
      "[`widgets@1.2.0`](https://github.com/acme/widgets/releases/tag/v1.2.0)",
    );
    expect(created[0].body).toContain(
      "<!-- shiprig-action:released release-sha -->",
    );
  });

  it("credits each pull request only for the packages its changesets named", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md", ".changeset/b.md"],
      changesets: {
        ".changeset/a.md": cs('"pkg-a": patch'),
        ".changeset/b.md": cs('"pkg-a": minor\n"pkg-b": minor'),
      },
      addedBy: { ".changeset/a.md": 1, ".changeset/b.md": 2 },
    });

    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [
        { name: "pkg-a", version: "1.1.0", tag: "pkg-a@1.1.0" },
        { name: "pkg-b", version: "2.1.0", tag: "pkg-b@2.1.0" },
      ],
      serverUrl: SERVER,
    });

    const byPr = Object.fromEntries(created.map((c) => [c.pr, c.body]));
    expect(byPr[1]).toContain("pkg-a@1.1.0");
    expect(byPr[1]).not.toContain("pkg-b@2.1.0");
    expect(byPr[2]).toContain("pkg-a@1.1.0");
    expect(byPr[2]).toContain("pkg-b@2.1.0");
  });

  it("merges two changesets from one pull request into one comment", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md", ".changeset/b.md"],
      changesets: {
        ".changeset/a.md": cs('"pkg-a": patch'),
        ".changeset/b.md": cs('"pkg-b": patch'),
      },
      addedBy: { ".changeset/a.md": 7, ".changeset/b.md": 7 },
    });

    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [
        { name: "pkg-a", version: "1.0.1", tag: "pkg-a@1.0.1" },
        { name: "pkg-b", version: "1.0.1", tag: "pkg-b@1.0.1" },
      ],
      serverUrl: SERVER,
    });

    expect(created).toHaveLength(1);
    expect(created[0].body).toContain("pkg-a@1.0.1");
    expect(created[0].body).toContain("pkg-b@1.0.1");
  });

  it("doesn't comment twice on a re-run", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md"],
      changesets: { ".changeset/a.md": cs('"widgets": patch') },
      addedBy: { ".changeset/a.md": 42 },
      existingComments: {
        42: ["🚀 Released in: …\n<!-- shiprig-action:released s -->"],
      },
    });

    const commented = await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
      serverUrl: SERVER,
    });

    expect(commented).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it("does nothing when the commit consumed no changesets (the README doesn't count)", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/README.md", "docs/old.md"],
      changesets: {},
      addedBy: {},
    });

    expect(
      await commentReleasedPrs({
        octokit,
        sha: "s",
        released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
        serverUrl: SERVER,
      }),
    ).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it("skips a changeset that names no released package", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md"],
      changesets: { ".changeset/a.md": cs('"an-ignored-package": patch') },
      addedBy: { ".changeset/a.md": 42 },
    });

    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
      serverUrl: SERVER,
    });

    expect(created).toHaveLength(0);
  });

  it("warns and carries on when one comment fails", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md", ".changeset/b.md"],
      changesets: {
        ".changeset/a.md": cs('"widgets": patch'),
        ".changeset/b.md": cs('"widgets": patch'),
      },
      addedBy: { ".changeset/a.md": 1, ".changeset/b.md": 2 },
      failComment: 1,
    });

    const commented = await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
      serverUrl: SERVER,
    });

    expect(commented).toEqual([2]);
    expect(created.map((c) => c.pr)).toEqual([2]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't comment on #1"),
    );
  });

  it("never throws: the release has already gone out", async () => {
    const octokit = {
      rest: {
        repos: {
          getCommit: async () => {
            throw new Error("Server Error");
          },
        },
      },
    } as unknown as CommentOctokit;

    await expect(
      commentReleasedPrs({
        octokit,
        sha: "s",
        released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
        serverUrl: SERVER,
      }),
    ).resolves.toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Server Error"),
    );
  });
});

describe("namesPackage", () => {
  it.each([
    ['"widgets": minor', "widgets", true],
    ["widgets: minor", "widgets", true],
    ["'@acme/widgets': patch", "@acme/widgets", true],
    // shiprig's conventional form: type/scope lines, then the quoted package
    [
      'type: fix\nscope: cli\n"github.com/acme/tool"',
      "github.com/acme/tool",
      true,
    ],
    ['"widgets-extra": minor', "widgets", false],
    ['"github.com/acme/tool/ui"', "github.com/acme/tool", false],
  ])("%j names %s: %s", (frontmatter, name, want) => {
    expect(namesPackage(cs(frontmatter), name)).toBe(want);
  });

  it("looks only at the frontmatter", () => {
    expect(
      namesPackage(
        '---\n"other": patch\n---\n\nAlso affects widgets\n',
        "widgets",
      ),
    ).toBe(false);
  });
});

describe("commentBody", () => {
  it("links each release by its tag", () => {
    const body = commentBody(
      [
        { name: "github.com/acme/tool/ui", version: "0.5.0", tag: "ui/v0.5.0" },
        { name: "@acme/cli", version: "2.0.0", tag: "@acme/cli@2.0.0" },
      ],
      SERVER,
      "<!-- m -->",
    );
    expect(body).toContain(
      "[`@acme/cli@2.0.0`](https://github.com/acme/widgets/releases/tag/@acme/cli@2.0.0)",
    );
    expect(body).toContain(
      "[`github.com/acme/tool/ui@0.5.0`](https://github.com/acme/widgets/releases/tag/ui/v0.5.0)",
    );
    expect(body.endsWith("<!-- m -->")).toBe(true);
  });
});
