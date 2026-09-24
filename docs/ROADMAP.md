# shiprig-action roadmap

Where shiprig-action goes next, measured against the two tools it sits
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
- **2. A config file: `shiprig-action.jsonc`** (v0.4.0). Named for the action
  rather than `.shiprig.jsonc`, since shiprig already reads `shiprig.jsonc` as
  its release-pipeline config, and read by the action rather than shiprig,
  since nothing outside the action uses these settings. Found in `.github/`,
  `.changeset/` or the working directory (more than one is an error); keys
  stand in for the inputs of the same name; an input set in the workflow wins,
  then the file, then the default; a schema in `schema/shiprig-action.json`.
  The hold label (`holdLabel`), Release-As (`releaseAs`, item 5) and a PR
  per group (`separatePullRequests`, item 6) have since joined it.
- **"Released in" comments** (v0.5.0). After a release, each pull request
  whose changeset shipped is told which package versions it went out in, as
  release-please and semantic-release do. Found through the changesets the
  version PR's merge consumed, so a monorepo PR is credited per package.
  Commit-sourced releases (`versioning.source: commits`) got them in v0.6.0.
- **Hold label, job summary, released-in for commit releases** (v0.6.0). A
  `release:hold` label on the version PR freezes its branch for hand edits;
  every run writes what it did to the job summary; a release from
  conventional commits credits the pull requests its changelog sections
  reference. Per-package skip (one package waits while another ships) needed
  shiprig to version only some packages; `shiprig version --ignore` arrived
  in shiprig 1.21.0 and item 6 builds on it.
- **`pr-status` on shiprig, with a changelog preview** (v0.6.0). The PR
  status comment plans with `shiprig status --since <base>`, so it shows each
  package's new version in any ecosystem, and a collapsible preview of the
  changelog entries the PR adds (`shiprig version --changelog --since`). It
  no longer needs `@changesets/cli`. With commits as a versioning source, the
  plan and preview cover the PR's own commits too (shiprig 1.21.0).

- **The split sub-actions on shiprig** (v0.6.0). `select-mode`, `pack`
  and `publish` run `shiprig publish-plan`, `shiprig pack` and `shiprig
publish --from-pack-dir` (shiprig 1.21.0), so the build → pack → publish
  job split works in any ecosystem that can publish a prebuilt file (npm,
  NuGet). The action no longer depends on `@changesets/cli`.
- **5. Release-As (D)** (unreleased). `releaseAs` in `shiprig-action.jsonc`
  maps a package to the exact version to release it at, passed to shiprig
  1.21.0's `version --release-as`. It applies while the package is releasing
  and below the version, and is skipped once reached, so an entry can stay
  in the file. Opt-in: without it, behaviour is canon's.

## Next

### 6. A version PR per release group (E)

Let an app and a library release on different schedules (release-please's
`separate-pull-requests`). Matters most in polyglot repos like tweed.
Built, waiting on an engine release:

- **Engine** (rigsmith/rigsmith#481): `status --output` reports
  each release's `group` (one changeset naming both, a dependency link, a
  fixed or linked group, a shared version file), and `version --only <pkg>`
  versions just the named packages alongside the config's `ignore`. Ships in
  shiprig 1.22.0, which needs sign-off.
- **Action** (#34): `separate-pull-requests` opens
  `changeset-release/<base>/<group>` per group, closes the PRs of groups
  with nothing pending (not held ones), publishes on the merge of any group's
  PR, and reports `pr-numbers`. Its tests run against a source build until
  1.22.0 is out; then the pinned shiprig moves and `MIN_SHIPRIG_VERSION`
  stays at 1.21.0 (the input checks the plan for groups instead).

### 9. A release record (comparison item 2)

release-please records what it released and where; canon @changesets trusts
`package.json`. Built in the engine, waiting on shiprig 1.22.0 like item 6:

- **The record** (rigsmith/rigsmith#482): opt-in `versioning.record` writes
  the version every package releases at into `.changeset/versions.json`
  (`released`), stamped or not. `doctor` flags a manifest edited by hand and
  a recorded release that was never tagged.
- **The last-release commit** (rigsmith/rigsmith#484): with commits as a
  versioning source, each package counts from the commit that recorded its
  current release, per package and merge-aware, instead of from a tag.
- **Tags as a fallback** (rigsmith/rigsmith#485): without a record, the tag
  lookup now finds tags named as the tag step names them (`name@version`,
  the `tagTemplate`). It used to find only Go-style `v1.2.0` tags, so
  commit-sourced monorepos counted their whole history on every release.

The action needs nothing for it: a repository turns it on in
`.changeset/config.json`.

## Later

### 8. Upstream issues

File changesets issues or discussions for comparison items 3, 7, 8 and 9 below.
A change to release decisions, like pre-1.0 behaviour (item 8), goes upstream
first, since shiprig matches canon @changesets.

### 10. Commit and PR links by default (comparison item 6)

Supported through `@changesets/changelog-github`, but not the default.

### Smaller follow-ups

- **Authenticated NuGet feeds in `publish-plan`.** shiprig's registry check
  sends no credentials, so a feed that needs them answers 401 and the plan
  fails (loudly). Asking with the publish credentials is a shiprig change.
- **Tight test timeouts.** A few tests that spawn a stand-in shiprig run under
  vitest's 5-second default and time out on a heavily loaded machine.

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

| #   | Idea                                        | release-please                             | changesets/action                          | shiprig / shiprig-action                                                |
| --- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | More than npm                               | Strategies for many ecosystems             | `package.json` only                        | **Covered**: shiprig's ecosystem adapters                               |
| 2   | A record of what was released               | Manifest plus `last-release-sha`           | Trusts `package.json`                      | **Built**: opt-in `versioning.record` (item 9, awaiting shiprig 1.22.0) |
| 3   | Publish only when the release PR merges     | `autorelease: pending` → `tagged` labels   | Publishes on every push with no changesets | **Covered**: `publish-on` (v0.3.0)                                      |
| 4   | Tags and GitHub Releases without a registry | The tag and GitHub Release are the release | Via `changeset publish` / `git-tag`        | **Covered**: `shiprig tag`, and the action's GitHub releases            |
| 5   | Changelog sections by type                  | `changelog-sections`                       | Major/Minor/Patch only                     | **Covered**: groups by conventional type                                |
| 6   | Commit and PR links by default              | On by default                              | Needs `changelog-github` and a token       | Partial: supported, not the default                                     |
| 7   | Forcing a version                           | `Release-As:`                              | None                                       | **Covered**: `releaseAs` (shiprig 1.21.0 `--release-as`)                |
| 8   | Pre-1.0 behaviour                           | `bump-minor-pre-major`                     | A major on 0.x goes to 1.0.0               | **Open**, upstream first                                                |
| 9   | Separate or grouped release PRs             | `separate-pull-requests`                   | One PR for everything                      | **Built**: item 6, awaiting shiprig 1.22.0                              |
| 10  | A fallback when authors forget              | Every conventional commit counts           | The bot only comments                      | Partial: `versioning.source: both`                                      |
| 11  | Config in one file                          | `release-please-config.json`               | Workflow inputs                            | **Covered**: `shiprig-action.jsonc` (v0.4.0)                            |

### Where changesets/action is already ahead: don't copy

- The dependency cascade and `fixed`/`linked` groups are far stronger than
  release-please's workspace plugins.
- Release notes are written on purpose by authors, not scraped from commit
  subjects.
- Deriving everything from commit messages as the default. It stays opt-in
  (`versioning.source: commits`).
