# shiprig-action roadmap

Where shiprig-action goes after v0.1.0, measured against the two tools it sits
between: the official `changesets/action` (its upstream) and Google's
`release-please`. Features that change release decisions belong in shiprig (see
[DESIGN.md](DESIGN.md#principles)); the action stays thin.

Moved from rigsmith's `docs/CHANGERIG-ACTION-ROADMAP.md` (rigsmith#442), which
was written on 2026-09-22 about rigsmith's own `.github/actions/release`
script. That script's gaps are listed there by letter (A–E), and the letters are
kept here.

Nothing here is scheduled; it's a ranked list to pick from.

## Done

- **A. Decide "is a release pending?" from the plan.** `src/index.ts` asks
  `shiprig status --output` instead of counting `.changeset/*.md`, so a
  prerelease waiting to graduate after `pre exit`, and repos that version from
  commits, both get a version PR. (Still broken in rigsmith's
  `.github/actions/release`, which dogfooding retires.)
- **C. Real release notes in the PR body.** Inherited from upstream: the body
  shows each package's rendered changelog entry.

- **B. Publish only when the version PR merges** (v0.3.0). `publish-on:
version-pr-merge`, the default, publishes on the push that merges
  `changeset-release/<base>` (found through the PRs GitHub associates with the
  commit) and on runs started by hand; `every-push` keeps changesets/action's
  behaviour. A tag the publish script already pushed is left alone instead of
  warning "Reference already exists", and a tag the action can't push fails the
  run.
- **4b. A stale queued run leaves the version PR alone** (v0.3.1). Release
  workflows queue their runs (`queue: max`, up to 100) and GitHub doesn't
  guarantee the order they start in. Before touching
  `changeset-release/<base>`, the action checks the base still points at the
  run's commit (and again just before pushing, since it can move during the
  run); if it has moved on, the newer run owns the version PR. The publish path
  is unaffected: a merge run with nothing left pending publishes its own commit
  whenever it runs (a pending changeset sends it down the version path
  instead).
- **4. No approval step on the version PR's CI.** Both this repository and
  rigsmith run the action as the shipRig GitHub App, so version PRs come from
  `shiprig[bot]` and their CI starts on its own.
- **1. Dogfood in rigsmith.** Stage 1 (version PR only, rigsmith#452) and
  stage 2 (the shipRig App tags on the release PR's merge and the tag starts
  GoReleaser, rigsmith#455, #461) are live; rigsmith 1.20.2 was the first
  release cut end to end. rigsmith's old `.github/actions/release` remains as
  its reusable action for other repos.

## Next

### 2. A config file: `.shiprig.jsonc`

The release-please equivalent of `release-please-config.json`: one committed
file for the settings that today are action inputs, plus the ones that have
no input yet.

- **Name and place.** `.shiprig.jsonc` or `.shiprig.json` (comments allowed in
  either), found in `.changeset/`, the repo root, or `.github/`. More than one
  is an error, not a merge, so there's never a question of which one won.
- **The engine owns it.** shiprig reads and validates it (published schema,
  like `changeset-config.json`), and a `shiprig config --json` prints the
  resolved settings. The action reads that through `src/shiprig.ts`, the same
  way it reads the release plan, so a laptop and CI resolve the same config.
- **Precedence.** An action input that's set wins, then the file, then the
  default. For that to work, the defaults move out of `action.yml` into code:
  today `commit-message` and `pr-title` always arrive "set" because
  `action.yml` fills them in.
- **Settings.** Top level, with a per-package section where it makes sense:
  - the version PR: title, commit message, branch, labels, draft;
  - `createGithubReleases` (rigsmith sets it to `false`, see stage 2);
  - when to publish (`publish-on`, an input since v0.3.0);
  - Release-As overrides (item 5);
  - a PR per package or group (item 6).
- **Separate from the release pipeline.** `.changeset/release.jsonc`
  configures the local `shiprig release` steps (version → commit → tag →
  push); `.shiprig.jsonc` configures the action. Neither reads the other's
  settings.

## Later

### 5. Non-interactive version override (D)

shiprig's override prompt can't be answered in CI. Add a non-interactive form:
a `Release-As`-style setting in `.shiprig.jsonc`, a flag, or a field in a
changeset. Opt-in, so default behaviour keeps matching canon.

### 6. A version PR per package (E)

Let an app and a library release on different schedules (release-please's
`separate-pull-requests`). Matters most in polyglot repos like tweed.

### 7. The split sub-actions (DESIGN phase 4)

`select-mode`, `pack` and `pr-status` still run the Changesets CLI.

### 8. Upstream issues

File changesets issues or discussions for comparison items 3, 7, 8 and 9 below.
A change to release decisions, like pre-1.0 behaviour (item 8), goes upstream
first, since shiprig matches canon @changesets.

## How the two upstream tools differ

Both keep a standing release PR that is rebuilt on every push and cut the
release when it merges. They differ in where the version decision comes from.

|                   | changesets/action (v2, CLI v3)                                | release-please                                                                  |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Bump source       | Changeset files authors add in their PRs                      | Conventional Commit messages (`feat:`, `fix:`, `!`)                             |
| Changelog text    | Hand-written for readers, one entry per changeset             | Generated from commit subjects                                                  |
| Release PR        | "Version Packages", rebuilt from pending changesets           | "chore: release …", rebuilt from commits since the last release                 |
| On merge          | Runs your publish script; can create tags and GitHub Releases | Creates tags and GitHub Releases; registry publishing is your own step          |
| Ecosystems        | npm (`package.json`) only                                     | Built-in strategies for Node, Python, Java, Go, Rust, Ruby, PHP, Helm, `simple` |
| Monorepos         | Dependency cascade, `fixed`/`linked` groups, `ignore`         | Manifest mode plus plugins (`node-workspace`, linked versions)                  |
| Prereleases       | `pre enter` / `pre exit`                                      | Prerelease settings in config                                                   |
| Configuration     | Action inputs plus `.changeset/config.json`                   | `release-please-config.json` plus a manifest                                    |
| Forcing a version | Write a changeset with the bump you want                      | `Release-As:` commit footer or `release-as` config                              |
| Failure mode      | A PR that forgets its changeset ships nothing                 | A sloppy commit message gives a wrong bump or a bad changelog line              |

### What changesets/action could learn from release-please

release-please treats a release as **repo state it tracks**; changesets treats
it as the consequence of files that happen to be present. Items 2, 3, 7 and 9
come from that difference. The last column is where shiprig and this action
stand.

| #   | Idea                                        | release-please                             | changesets/action                          | shiprig / shiprig-action                                                           |
| --- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | More than npm                               | Strategies for many ecosystems             | `package.json` only                        | **Covered**: shiprig's ecosystem adapters                                          |
| 2   | A record of what was released               | Manifest plus `last-release-sha`           | Trusts `package.json`                      | Partial: `.changeset/versions.json` for unstamped versions; no last-release commit |
| 3   | Publish only when the release PR merges     | `autorelease: pending` → `tagged` labels   | Publishes on every push with no changesets | **Covered**: `publish-on` (v0.3.0)                                                 |
| 4   | Tags and GitHub Releases without a registry | The tag and GitHub Release are the release | Via `changeset publish` / `git-tag`        | **Covered**: `shiprig tag`, and the action's GitHub releases                       |
| 5   | Changelog sections by type                  | `changelog-sections`                       | Major/Minor/Patch only                     | **Covered**: groups by conventional type                                           |
| 6   | Commit and PR links by default              | On by default                              | Needs `changelog-github` and a token       | Partial: supported, not the default                                                |
| 7   | Forcing a version                           | `Release-As:`                              | None                                       | Partial: interactive prompt only; item 5                                           |
| 8   | Pre-1.0 behaviour                           | `bump-minor-pre-major`                     | A major on 0.x goes to 1.0.0               | **Open**, upstream first                                                           |
| 9   | Separate or grouped release PRs             | `separate-pull-requests`                   | One PR for everything                      | **Open**: item 6                                                                   |
| 10  | A fallback when authors forget              | Every conventional commit counts           | The bot only comments                      | Partial: `versioning.source: both`                                                 |
| 11  | Config in one file                          | `release-please-config.json`               | Workflow inputs                            | **Open**: item 2                                                                   |

### Where changesets/action is already ahead: don't copy

- The dependency cascade and `fixed`/`linked` groups are far stronger than
  release-please's workspace plugins.
- Release notes are written on purpose by authors, not scraped from commit
  subjects.
- Deriving everything from commit messages as the default. It stays opt-in
  (`versioning.source: commits`).
