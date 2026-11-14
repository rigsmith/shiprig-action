import { exec, getExecOutput, type ExecOptions } from "@actions/exec";

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
 * tag to the tag's commit when either isn't there, as after a push that
 * failed partway or a vN moved by hand. Returns whether it moved them.
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
  const { stdout } = await getExecOutput(
    "git",
    [
      "ls-remote",
      "origin",
      // An annotated tag's peeled (^{}) entry, its commit, is listed only
      // when asked for by name.
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
      `refs/heads/${releaseLine}`,
      `refs/tags/${releaseLine}`,
      `refs/tags/${releaseLine}^{}`,
    ],
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
  if (
    commitOf(`refs/heads/${releaseLine}`) === target &&
    commitOf(`refs/tags/${releaseLine}`) === target
  ) {
    return false;
  }
  console.log(
    `${releaseLine} doesn't point at ${tag}; moving the ${releaseLine} branch and tag to it.`,
  );
  const authed = pushEnv();
  // The release commit isn't on main: fetch it through its tag.
  await exec(
    "git",
    ["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    { cwd, env: authed },
  );
  await exec(
    "git",
    [
      "push",
      "--atomic",
      "origin",
      `+${target}:refs/heads/${releaseLine}`,
      `+${target}:refs/tags/${releaseLine}`,
    ],
    { cwd, env: authed },
  );
  return true;
}
