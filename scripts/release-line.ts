import { exec, getExecOutput, type ExecOptions } from "@actions/exec";
import semver from "semver";

// The release line (vN) as a branch and a tag of the same name, both on the
// latest stable release's commit. Kept apart from release.ts, which runs at
// import, so the pushes can be tested against a local remote.

type Options = {
  cwd: string;
  /** The release's tag, vX.Y.Z. */
  tag: string;
  /** The release line, vN. */
  releaseLine: string;
  env: ExecOptions["env"];
};

/**
 * Pushes the release: its tag, and the vN branch and tag moved to it, in one
 * atomic push, so a ref the remote refuses (a ruleset on the vN tag, say)
 * leaves all three as they were. A partial push would leave the version tag
 * out with vN behind, and the next run, finding the tag, would never move it.
 * The vN refs are forced; the version tag never is.
 */
export async function pushRelease({ cwd, tag, releaseLine, env }: Options) {
  await exec(
    "git",
    [
      "push",
      "--atomic",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
      `+HEAD:refs/heads/${releaseLine}`,
      `+HEAD:refs/tags/${releaseLine}`,
    ],
    { cwd, env },
  );
}

/**
 * For a release whose tag is already on the remote: moves the vN branch and
 * tag to the tag's commit when either is missing or behind it, as after a
 * push that failed partway or a vN moved by hand. Only forward: re-running an
 * older release finds vN on a newer one and leaves it there, so `@vN` never
 * goes back to an older build. Returns whether it moved anything.
 *
 * Release commits are siblings off main (each is main plus dist/), so "behind"
 * means the ref's commit is an ancestor of the target (a vN left on main), or
 * carries a release tag older than this one. A ref that's neither (a newer
 * release, or a commit it can't place) stops the realign with a warning.
 *
 * The push leases each vN ref on the value read here (a missing one on
 * staying missing), so a release that moves vN meanwhile isn't overwritten.
 * `pushEnv` is asked for only when a push is due, so a run with nothing to
 * repair needs no push token.
 */
export async function realignReleaseLine({
  cwd,
  tag,
  releaseLine,
  env,
  pushEnv,
}: Options & {
  pushEnv: () => ExecOptions["env"];
}): Promise<boolean> {
  // Every release tag (peeled entries included, which a glob lists) and the
  // vN branch.
  const { stdout } = await getExecOutput(
    "git",
    ["ls-remote", "origin", `refs/heads/${releaseLine}`, "refs/tags/v*"],
    { cwd, env, silent: true },
  );
  const refs = new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split("\t");
        return [ref, sha] as const;
      }),
  );
  const commitOf = (ref: string) => refs.get(`${ref}^{}`) ?? refs.get(ref);
  const target = commitOf(`refs/tags/${tag}`);
  if (target === undefined) {
    throw new Error(`${tag} isn't on the remote`);
  }
  const version = tag.slice(1);

  // The commits needed to place each ref: the release commit isn't on main,
  // and nor is whatever vN names now. Fetched under a scratch namespace.
  const lineRefs = [`refs/heads/${releaseLine}`, `refs/tags/${releaseLine}`];
  const existing = lineRefs.filter((ref) => refs.has(ref));
  await exec(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/tags/${tag}:refs/release-line/target`,
      ...existing.map((ref, i) => `+${ref}:refs/release-line/current-${i}`),
    ],
    { cwd, env, silent: true },
  );

  const isAncestor = async (a: string, b: string) =>
    (
      await getExecOutput("git", ["merge-base", "--is-ancestor", a, b], {
        cwd,
        ignoreReturnCode: true,
        silent: true,
      })
    ).exitCode === 0;
  // The release versions whose tags name this commit.
  const releasesAt = (commit: string) =>
    [...refs.keys()]
      .filter((ref) => /^refs\/tags\/v[^/^]+$/.test(ref))
      .filter((ref) => commitOf(ref) === commit)
      .map((ref) => ref.slice("refs/tags/v".length))
      .filter((v) => semver.valid(v));

  const moves: { ref: string; expected: string }[] = [];
  for (const ref of lineRefs) {
    // What the ref holds (a tag object for an annotated tag), and its commit.
    const value = refs.get(ref);
    const current = commitOf(ref);
    if (value === undefined || current === undefined) {
      moves.push({ ref, expected: "" });
      continue;
    }
    if (current === target) continue;
    const behind =
      (await isAncestor(current, target)) ||
      releasesAt(current).some((v) => semver.lt(v, version));
    if (!behind) {
      const at = releasesAt(current);
      console.warn(
        `::warning::${ref} is on ${at.length ? `v${at.join(", v")}` : current.slice(0, 7)}, which isn't behind ${tag}; leaving ${releaseLine} where it is rather than moving it back.`,
      );
      return false;
    }
    moves.push({ ref, expected: value });
  }
  if (moves.length === 0) return false;

  console.log(
    `${releaseLine} doesn't point at ${tag}; moving ${moves.map((m) => m.ref).join(" and ")} to it.`,
  );
  await exec(
    "git",
    [
      "push",
      "--atomic",
      ...moves.map((m) => `--force-with-lease=${m.ref}:${m.expected}`),
      "origin",
      ...moves.map((m) => `${target}:${m.ref}`),
    ],
    { cwd, env: pushEnv() },
  );
  return true;
}
