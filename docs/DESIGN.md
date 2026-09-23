# shiprig-action design

`rigsmith/shiprig-action` is [changesets/action](https://github.com/changesets/action)
(v2.1.2, MIT) driving **shiprig** instead of the npm-only Changesets CLI. It keeps
upstream's flow unchanged: a standing version PR while releases are pending;
publish, tag and GitHub releases when it merges. What changes is what's behind
it: every ecosystem shiprig supports, and changesets and/or conventional commits
as the source.

## Principles

1. **The action stays thin; the engine owns the features.** Ecosystem adapters,
   changelog generators, and the versioning source (`changesets`, `commits`,
   `both`) are plugins or config in changerig/shiprig
   ([PLUGIN-PROTOCOL](https://github.com/rigsmith/rigsmith/blob/main/docs/PLUGIN-PROTOCOL.md)).
   The release-please qualities we want (ecosystem plugins, changelog styling,
   conventional commits) come from there, so the CLI, local runs and CI all
   behave the same. The action only orchestrates the GitHub side.
2. **Speak canon's contracts.** Where upstream talks to the Changesets CLI through
   a documented contract (`status --output`, `CHANGESETS_OUTPUT` git-tag events,
   `publish-plan`), shiprig implements that same contract instead of the action
   inventing a new one. This follows the rule that changerig matches canonical
   @changesets.
3. **Keep the diff against upstream small.** All shiprig specifics sit behind
   one adapter module, `src/shiprig.ts`, so upstream fixes can still be merged
   in (`git fetch upstream && git merge upstream/main`). The `upstream` remote
   is fetch-only.

## Where upstream assumes npm, and what replaced it

Rows 1–6 and 8 are done: the rigsmith side shipped in shiprig 1.20.0, the
action side in #7. Row 7 is phase 4.

| #   | Upstream (npm-only)                                                                           | shiprig-action                                                                                                                                                                                                                                                                                                 | Status                            |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `@changesets/cli` from `node_modules` (`execChangesetsCli`, `validateChangesetsCliVersion`)   | `shiprig` on `PATH`, or at `$SHIPRIG_BIN`. The job installs it; the action doesn't. There's no version check (`--version` prints a banner): an older shiprig fails at `packages list --json` with a message naming the minimum, 1.20.0, and a missing one with `@actions/exec`'s "Unable to locate executable" | Done                              |
| 2   | `@changesets/read` + `@changesets/pre` (`readChangesetState`): is anything pending?           | `shiprig status --output`: the engine's plan, covering commit-sourced releases, ignored and private packages, and prerelease graduation. An empty plan with exit 0 means nothing pending; a non-zero exit is thrown, never read as "nothing"                                                                   | Done (rigsmith#447)               |
| 3   | `@manypkg/get-packages`: packages, versions before and after `version`, changelogs, `private` | `shiprig packages list --json`, with paths made absolute. Works in a repo with no `.changeset/` directory                                                                                                                                                                                                      | Done (rigsmith#445, rigsmith#449) |
| 4   | `changeset version`                                                                           | `shiprig version --yes`                                                                                                                                                                                                                                                                                        | Done                              |
| 5   | `getChangelogEntry` on `<dir>/CHANGELOG.md`                                                   | Unchanged parser (changerig writes canon's format), reading the path from row 3. A stackspace's shared root `CHANGELOG.md` is read per package section                                                                                                                                                         | Done                              |
| 6   | `changeset publish` + `CHANGESETS_OUTPUT` NDJSON `{type:"git-tag", tag, packageName}`         | `shiprig publish --yes` writes the same events, tags locally only, and leaves the push to the action. It checks the events file before touching a registry, and never reports or rolls back a tag it didn't create                                                                                             | Done (rigsmith#446)               |
| 7   | `changeset publish-plan`, `pack`, `publish --from-pack-dir` (the split sub-actions)           | Not ported. `select-mode` and `pack` still run the Changesets CLI; the `publish` sub-action rejects `pack-dir-artifact-id` before downloading anything                                                                                                                                                         | Phase 4                           |
| 8   | Wording, branch `changeset-release/<base>`, action name                                       | shiprig wording in the PR body and `action.yml`; the branch name is **kept**, so changeset-bot and existing workflows keep working                                                                                                                                                                             | Done                              |

## Decisions made along the way

- **shiprig is required.** Custom `version-script`/`publish-script` still need it:
  shiprig's plan is what tells the action to open a version PR or publish. That's
  the only way to see a pending conventional-commit release or a prerelease
  waiting to graduate. A job that doesn't want shiprig should use changesets/action.
- **Discovery is the engine's.** The action trusts the names and paths shiprig
  reports rather than re-reading manifests. Duplicate package names are refused
  in shiprig itself (rigsmith#448).
- **`has-changesets` keeps upstream's meaning:** changeset files exist. It counts
  `.changeset/pre/` once `pre exit` has run and leaves it out in pre mode, as
  upstream's reader does. A conventional-commit release drives the flow without
  setting it.
- **Prerelease state fails closed.** Only a missing `pre.json` means "not in
  prerelease". An unreadable or malformed file, an unknown mode, or a blank tag is
  an error, never a silent normal release or a `( )` in the PR title.
- **Upstream's own release workflow** (`publish.yml`) is limited to
  `changesets/action`, so it can't publish upstream's action from this repo.

## Testing

- **Upstream's tests run against the real shiprig,** in the same fixtures. The
  only snapshot change was the PR header sentence naming shiprig-action.
- **Polyglot tests** (npm + Cargo) check that one version PR lists both
  ecosystems' releases, and that publishing creates a GitHub release for each tag
  shiprig reports. They fail if package lookup is limited to npm.
- **shiprig comes from the lockfile.** `@rigsmith/shiprig` is an exact
  devDependency, so `pnpm install --frozen-lockfile` checks it and its platform
  packages against the sha512 in `pnpm-lock.yaml`. Those exact versions are in
  `minimumReleaseAgeExclude`, as upstream does for its own first-party packages.
- **The global test setup** runs the binary (the pinned one, or `$SHIPRIG_BIN`)
  and requires `packages list --json`, with a 30 s timeout, so a missing, older or
  hung shiprig fails there with a clear message instead of inside the tests.
- **No test reaches a registry.** Publishing tests use `shiprig tag`, which
  writes the same events locally, or a stand-in binary.

## Phases

**0. Mirror.** `main` started as upstream v2.1.2, unchanged. Done.

**1. Engine (rigsmith).** `packages list --json`, the `CHANGESETS_OUTPUT` git-tag
events, and `status` gating as canon does (rigsmith#445 through rigsmith#449). Done, released in
shiprig 1.20.0.

**2. The root action on shiprig.** Rows 1–6 and 8 behind `src/shiprig.ts` (#7).
Still to do before it's usable:

- rewrite the README for shiprig (#8);
- release the action (upstream force-adds `dist/` in release commits, so it's
  used from a tag, never `main`);
- dogfood it by replacing `rigsmith/.github/actions/release`, then retire that
  action.

**3. Roadmap** (from rigsmith's `docs/CHANGERIG-ACTION-ROADMAP.md`). Upstream's
design already covers two of its items: prerelease graduation is detected, and
the PR body carries each package's changelog entry. What remains:

- publish only when the version PR merges (a label or commit check, instead of
  "no changesets means publish");
- a non-interactive `Release-As` / version override (engine flag, action input);
- a version PR per package, or grouped, as an option.

**4. The split sub-actions** (row 7), for the build → pack → trusted-publish
job split.

## Plugins

The action has no plugin system of its own, deliberately. Plugins run in the
engine, so they work the same in `shiprig version` on a laptop and in CI:

- **Ecosystem adapters:** subprocess JSON (`info`, `detect`, `discover`,
  `set-version`, `publish`). The built-ins use the same contract.
- **Changelog generators:** the `changelog` config (`default`,
  `@changesets/changelog-git`, `@changesets/changelog-github`, or a subprocess
  plugin).
- **Version source:** `versioning.source` is `changesets` (canon), `commits`
  (conventional commits), or `both`.

## License

MIT, inherited: `LICENSE` is upstream's, unchanged.
