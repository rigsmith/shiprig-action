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
   `both`) are already plugins or config in changerig/shiprig
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
   one adapter module (`src/shiprig.ts`), so upstream fixes can still be merged
   in (`git fetch upstream && git merge upstream/main`). The `upstream` remote
   is fetch-only.

## Where upstream assumes npm, and what replaces it

| # | Upstream dependency | Used for | shiprig replacement | Engine status |
|---|---|---|---|---|
| 1 | `@changesets/cli` in `node_modules` (`validateChangesetsCliVersion`, `execChangesetsCli`) | Running the CLI | Resolve the `shiprig` binary: on PATH, or installed by the action (`shiprig-version` input, reusing rigsmith's `install-shiprig.sh`), with a minimum-version check | Exists |
| 2 | `@changesets/read` + `@changesets/pre` (`readChangesetState`) | Is anything pending? Are we in pre mode? | `shiprig status --output plan.json` plus `.changeset/pre.json`. The plan is the engine's answer, so it covers commit-sourced releases, private and ignored packages, and prerelease graduation | Exists (#441). Needs a check that the "no changesets" exit is distinguishable from a real failure |
| 3 | `@manypkg/get-packages` (`getPackages`, `getVersionsByDirectory`, `getChangedPackages`) | Package list, versions before and after `version`, changelog paths, `private` | `shiprig packages list --json`: name, ecosystem, dir, version, private, changelog path | **New** |
| 4 | `changeset version` | The version commit | `shiprig version` | Exists |
| 5 | `getChangelogEntry` parsing `CHANGELOG.md` | PR body and GitHub release notes | Unchanged: changerig writes canon's format. The path comes from #3 instead of `<dir>/CHANGELOG.md` | Exists |
| 6 | `changeset publish` + `CHANGESETS_OUTPUT` NDJSON `{type:"git-tag", tag, packageName}` | Which tags to push and which releases to create | `shiprig publish` appends the same events when `CHANGESETS_OUTPUT` is set, creating tags locally and leaving the push to the action (signed through the API by default) | **New** |
| 7 | `changeset publish-plan`, `pack`, `publish --from-pack-dir` | The split sub-actions (`select-mode`, `pack`, `publish`) for separate build and trusted-publish jobs | shiprig equivalents | **New**, phase 4 |
| 8 | Wording, branch `changeset-release/<base>`, action name | UX | shiprig wording; **keep** the branch name so changeset-bot and existing workflows keep working | — |

## Phases

**0. Mirror.** `main` is upstream v2.1.2, unchanged. Done.

**1. Engine (rigsmith).** Rows 2, 3 and 6: `shiprig packages list --json`; the
`CHANGESETS_OUTPUT` git-tag events, with a publish mode that tags locally and
doesn't push; and a clean "nothing pending" signal from `status --output`. Each
is a canon contract or a small JSON listing, tested in rigsmith.

**2. The root action on shiprig.** Swap rows 1–6 behind `src/shiprig.ts`, adapt
upstream's tests (vitest, snapshots) to polyglot fixtures, and bundle `dist/`.
Dogfood it by replacing `rigsmith/.github/actions/release`, then retire that
action.

**3. Roadmap** (from rigsmith's `docs/CHANGERIG-ACTION-ROADMAP.md`). The first
two are already done by upstream's design: prerelease graduation is detected
(`pre/` changesets count in exit mode), and the PR body already carries each
package's changelog entry. What remains:
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

MIT, inherited. Upstream's copyright notice stays; rigsmith's is added beside
it, not in place of it.
