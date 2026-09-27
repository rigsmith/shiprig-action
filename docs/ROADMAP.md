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
- **Authenticated NuGet feeds in `publish-plan`** (shiprig 1.22.0,
  rigsmith/rigsmith#488). A private feed that answers 401 is asked again with
  the publish credential (`dotnet.auth`, else `NUGET_API_KEY`) as HTTP Basic
  auth, only on the feed's own host, over https. The action needs nothing.
- **Engine work since shiprig 1.21.0** (all on rigsmith main, in 1.22.0):
  changelog generator plugins receive their options, each change's commit
  and PR, and the released dependencies (rigsmith/rigsmith#489); a changelog
  entry no longer mixes typed and `Minor/Patch Changes` headings (#489);
  `"changelog": "@changesets/cli/changelog"` renders again (#489); commit
  mode skips `chore(deps)`, `chore(release)` and release commits, as
  changelogen does (#490); commit-sourced changeset IDs can't collide (#491);
  an ignored package no longer rewrites its dependents' ranges (#487).
- **Single-quoted package names and a dependency-only 🩹 Fixes section**
  (rigsmith/rigsmith#494, #495; found by the 1.22.0 stability check).
  Changeset frontmatter is read as the YAML @changesets reads, so
  `'@acme/lib': patch` works; and a typed entry lists its released
  dependencies under 🌊 Dependencies rather than as a lone Fixes line.
- **Tight test timeouts** (#35). Tests that run real git and shiprig
  processes get a 20-second budget instead of vitest's 5-second default.
- **5. Release-As (D)** (unreleased). `releaseAs` in `shiprig-action.jsonc`
  maps a package to the exact version to release it at, passed to shiprig
  1.21.0's `version --release-as`. It applies while the package is releasing
  and below the version, and is skipped once reached, so an entry can stay
  in the file. Opt-in: without it, behaviour is canon's.

- **shiprig 1.22.0** (released 2026-09-26). It carries the engine side of
  items 6, 9, 10 and 11:
  - **6.** `status --output` gives each release its `group`, and
    `version --only <pkg>` versions just the named groups
    (rigsmith/rigsmith#481).
  - **9. A release record.** Opt-in `versioning.record` writes what every
    package released at into `.changeset/versions.json`, and `doctor` flags
    a hand-edited manifest and an untagged recorded release (#482). With
    commits as a source, each package counts from the commit that recorded
    its last release (#484), and without a record the tag lookup finds tags
    as the tag step names them (#485).
  - **10. Commit and PR links.** The docs say when to turn on
    `@changesets/changelog-github`, and `changerig init` offers it on a
    GitHub repository (#493).
  - **11. Pre-1.0 behaviour.** Opt-in `"versioning": { "bumpMinorPreMajor":
true }` releases a major on `0.x` as a minor, as release-please's
    `bump-minor-pre-major` does (#492).

  Also in 1.22.0: `status --output` writes canon's whole release plan (#496),
  `doctor` reports every problem (#497), the changeset reader refuses what
  canon refuses (#498), and changelog commit hashes stay unique (#499).

- **6. A version PR per release group (E)** (unreleased, #34).
  `separate-pull-requests` opens `changeset-release/<base>/<group>` per
  group, closes the PRs of groups with nothing pending (not held ones),
  publishes on the merge of any group's PR, and reports `pr-numbers`. The
  tests run against shiprig 1.22.0; `MIN_SHIPRIG_VERSION` stays at 1.21.0,
  and the input checks the plan for groups instead.
- **pr-status warns about unreleased packages** (unreleased, #36). A PR that
  changes a package nothing in it releases gets a "Changed but not released"
  note, a warning annotation and an `unreleased-packages` output. It never
  fails the job; comparison row 10.
- **README API tables checked in CI** (#37).

## Next

**Release 0.6.0** (#27, the standing release PR). Everything above marked
unreleased ships with it: `releaseAs` (5), `separate-pull-requests` (6),
pr-status's unreleased-package warning, and the README tables check.

## Later

### Not ours

- **Upstream issues** (formerly item 8). Whether @changesets adopts
  publish-on-merge, forcing a version, pre-1.0 behaviour or grouped PRs is
  its maintainers' call; this project won't propose them.

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

| #   | Idea                                        | release-please                             | changesets/action                          | shiprig / shiprig-action                                          |
| --- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| 1   | More than npm                               | Strategies for many ecosystems             | `package.json` only                        | **Covered**: shiprig's ecosystem adapters                         |
| 2   | A record of what was released               | Manifest plus `last-release-sha`           | Trusts `package.json`                      | **Covered**: opt-in `versioning.record` (item 9, shiprig 1.22.0)  |
| 3   | Publish only when the release PR merges     | `autorelease: pending` → `tagged` labels   | Publishes on every push with no changesets | **Covered**: `publish-on` (v0.3.0)                                |
| 4   | Tags and GitHub Releases without a registry | The tag and GitHub Release are the release | Via `changeset publish` / `git-tag`        | **Covered**: `shiprig tag`, and the action's GitHub releases      |
| 5   | Changelog sections by type                  | `changelog-sections`                       | Major/Minor/Patch only                     | **Covered**: groups by conventional type                          |
| 6   | Commit and PR links by default              | On by default                              | Needs `changelog-github` and a token       | **Covered**: docs, and `init` offers it (item 10, shiprig 1.22.0) |
| 7   | Forcing a version                           | `Release-As:`                              | None                                       | **Covered**: `releaseAs` (shiprig 1.21.0 `--release-as`)          |
| 8   | Pre-1.0 behaviour                           | `bump-minor-pre-major`                     | A major on 0.x goes to 1.0.0               | **Covered**: opt-in `bumpMinorPreMajor` (item 11, shiprig 1.22.0) |
| 9   | Separate or grouped release PRs             | `separate-pull-requests`                   | One PR for everything                      | **Built**: `separate-pull-requests` (item 6, unreleased)          |
| 10  | A fallback when authors forget              | Every conventional commit counts           | The bot only comments                      | **Covered**: `source: both`, and pr-status warns (unreleased)     |
| 11  | Config in one file                          | `release-please-config.json`               | Workflow inputs                            | **Covered**: `shiprig-action.jsonc` (v0.4.0)                      |

### Where changesets/action is already ahead: don't copy

- The dependency cascade and `fixed`/`linked` groups are far stronger than
  release-please's workspace plugins.
- Release notes are written on purpose by authors, not scraped from commit
  subjects.
- Deriving everything from commit messages as the default. It stays opt-in
  (`versioning.source: commits`).
