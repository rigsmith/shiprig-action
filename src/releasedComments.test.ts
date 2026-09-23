import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CommentOctokit,
  commentBody,
  commentReleasedPrs,
  namesPackage,
  referencesIn,
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
  otherFiles?: number; // unrelated files in the commit, before the changesets
  edits?: Record<string, number>; // commits editing a changeset after it was added
  failLookup?: string; // a changeset whose history can't be read
}) {
  const files = [
    ...Array.from({ length: opts.otherFiles ?? 0 }, (_, i) => ({
      filename: `packages/p${i}/CHANGELOG.md`,
      status: "modified",
    })),
    ...opts.removed.map((filename) => ({ filename, status: "removed" })),
  ];
  const created: { pr: number; body: string }[] = [];
  const octokit: CommentOctokit = {
    rest: {
      repos: {
        getCommit: async ({ per_page, page }) => ({
          data: {
            parents: [{ sha: "parent" }],
            files: files.slice((page - 1) * per_page, page * per_page),
          },
        }),
        getContent: async ({ path }) => ({
          data: {
            content: Buffer.from(opts.changesets[path] ?? "").toString(
              "base64",
            ),
          },
        }),
        listCommits: async ({ path, per_page, page }) => {
          if (path === opts.failLookup) throw new Error("Server Error");
          // newest first; the last is the commit that added the file
          const all = [
            ...Array.from({ length: opts.edits?.[path] ?? 1 }, (_, i) => ({
              sha: `edit-${i}-of-${path}`,
            })),
            { sha: `add-of-${path}` },
          ];
          return { data: all.slice((page - 1) * per_page, page * per_page) };
        },
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
        listComments: async ({ issue_number, per_page, page }) => ({
          data: (opts.existingComments?.[issue_number] ?? [])
            .slice((page - 1) * per_page, page * per_page)
            .map((body) => ({ body })),
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

  it("finds consumed changesets past the first page of the commit's files", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md"],
      changesets: { ".changeset/a.md": cs('"widgets": patch') },
      addedBy: { ".changeset/a.md": 42 },
      otherFiles: 250,
    });
    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
      serverUrl: SERVER,
    });
    expect(created.map((c) => c.pr)).toEqual([42]);
  });

  it("finds the adding commit of a changeset edited more than a page of times", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md"],
      changesets: { ".changeset/a.md": cs('"widgets": patch') },
      addedBy: { ".changeset/a.md": 42 },
      edits: { ".changeset/a.md": 150 },
    });
    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
      serverUrl: SERVER,
    });
    expect(created.map((c) => c.pr)).toEqual([42]);
  });

  it("still comments for the other changesets when one can't be traced", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md", ".changeset/b.md"],
      changesets: {
        ".changeset/a.md": cs('"widgets": patch'),
        ".changeset/b.md": cs('"widgets": patch'),
      },
      addedBy: { ".changeset/a.md": 1, ".changeset/b.md": 2 },
      failLookup: ".changeset/a.md",
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
      expect.stringContaining("added .changeset/a.md"),
    );
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

  it("finds its earlier comment past the first page of comments", async () => {
    const { octokit, created } = fakeGitHub({
      removed: [".changeset/a.md"],
      changesets: { ".changeset/a.md": cs('"widgets": patch') },
      addedBy: { ".changeset/a.md": 42 },
      existingComments: {
        42: [
          ...Array.from({ length: 150 }, (_, i) => `review comment ${i}`),
          "🚀 Released in: …\n<!-- shiprig-action:released s -->",
        ],
      },
    });

    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [{ name: "widgets", version: "1.0.1", tag: "v1.0.1" }],
      serverUrl: SERVER,
    });

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

describe("releases from commits (no changesets consumed)", () => {
  // A commit that removed no changesets, and an API that knows which merged
  // pull request each commit came from.
  function commitsGitHub(prOf: Record<string, number>) {
    const created: { pr: number; body: string }[] = [];
    const lookups: string[] = [];
    const octokit: CommentOctokit = {
      rest: {
        repos: {
          getCommit: async ({ ref }) => ({
            data: {
              sha: ref === "s" ? "s" : `${ref}-full`,
              parents: [{ sha: "parent" }],
              files: [],
            },
          }),
          getContent: async () => ({ data: {} }),
          listCommits: async () => ({ data: [] }),
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
            lookups.push(commit_sha);
            const pr = prOf[commit_sha.replace(/-full$/, "")];
            return {
              data:
                pr === undefined
                  ? []
                  : [{ number: pr, merged_at: "2026-09-23T00:00:00Z" }],
            };
          },
        },
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async ({ issue_number, body }) => {
            created.push({ pr: issue_number, body });
            return {};
          },
        },
      },
    };
    return { octokit, created, lookups };
  }

  it("looks a commit up once when several packages' sections name it", async () => {
    const { octokit, created, lookups } = commitsGitHub({ abc1234: 40 });
    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: ["widgets", "gadgets"].map((name) => ({
        name,
        version: "1.2.0",
        tag: `${name}@1.2.0`,
        notes: "- abc1234: feat: a shared thing\n",
      })),
      serverUrl: SERVER,
    });
    expect(lookups).toEqual(["abc1234-full"]);
    expect(created.map((c) => c.pr)).toEqual([40]);
    expect(created[0].body).toContain("widgets@1.2.0");
    expect(created[0].body).toContain("gadgets@1.2.0");
  });

  it("credits the pull requests a changelog-github section links", async () => {
    const { octokit, created } = commitsGitHub({});
    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [
        {
          name: "widgets",
          version: "1.2.0",
          tag: "v1.2.0",
          notes:
            "### Minor Changes\n\n- [#31](https://github.com/acme/widgets/pull/31) [`abc1234`](https://github.com/acme/widgets/commit/abc1234) Thanks! - feat: a thing\n",
        },
      ],
      serverUrl: SERVER,
    });
    expect(created.map((c) => c.pr)).toEqual([31]);
  });

  it("maps a changelog-git section's commits to their pull requests", async () => {
    const { octokit, created } = commitsGitHub({ abc1234: 40, def5678: 41 });
    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [
        {
          name: "widgets",
          version: "1.2.0",
          tag: "v1.2.0",
          notes: "- abc1234: feat: a thing\n- def5678: fix: another\n",
        },
      ],
      serverUrl: SERVER,
    });
    expect(created.map((c) => c.pr).sort()).toEqual([40, 41]);
  });

  it("credits each package only for its own section's references", async () => {
    const { octokit, created } = commitsGitHub({});
    await commentReleasedPrs({
      octokit,
      sha: "s",
      released: [
        {
          name: "pkg-a",
          version: "1.1.0",
          tag: "pkg-a@1.1.0",
          notes: "- [#1](https://github.com/acme/widgets/pull/1) - a\n",
        },
        {
          name: "pkg-b",
          version: "2.0.1",
          tag: "pkg-b@2.0.1",
          notes: "- [#2](https://github.com/acme/widgets/pull/2) - b\n",
        },
      ],
      serverUrl: SERVER,
    });
    const byPr = Object.fromEntries(created.map((c) => [c.pr, c.body]));
    expect(byPr[1]).toContain("pkg-a@1.1.0");
    expect(byPr[1]).not.toContain("pkg-b");
    expect(byPr[2]).toContain("pkg-b@2.0.1");
  });

  it("comments on nothing when the changelog references nothing", async () => {
    const { octokit, created } = commitsGitHub({});
    expect(
      await commentReleasedPrs({
        octokit,
        sha: "s",
        released: [
          {
            name: "widgets",
            version: "1.2.0",
            tag: "v1.2.0",
            notes: "- **cli:** a plain entry\n",
          },
        ],
        serverUrl: SERVER,
      }),
    ).toEqual([]);
    expect(created).toHaveLength(0);
  });
});

describe("referencesIn", () => {
  it("finds this repository's pull request links and both commit forms", () => {
    const refs = referencesIn(
      [
        "- [#31](https://github.com/acme/widgets/pull/31) [`abc1234`](https://github.com/acme/widgets/commit/abc1234) - a",
        "- [#9](https://github.com/someone/else/pull/9) - not ours",
        "- def5678: fix: another",
      ].join("\n"),
    );
    expect(refs.pullRequests).toEqual([31]);
    expect(refs.commits.sort()).toEqual(["abc1234", "def5678"]);
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
    // a scope line isn't a package key
    ['type: fix\nscope: widgets\n"github.com/acme/tool"', "widgets", false],
    ['  "widgets": minor', "widgets", true],
    // metadata lines aren't package entries, even for packages named so
    ['type: fix\nscope: cli\n"widgets"', "type", false],
    ['type: fix\nscope: cli\n"widgets"', "scope", false],
    ['"type": minor', "type", true],
    ['"scope": patch', "scope", true],
    ["widgets:", "widgets", true],
    // shiprig's metadata keys, even with a bump word for a value
    ["scope: patch", "scope", false],
    ["type: minor", "type", false],
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
