# shiprig-action

## 0.6.0

### Minor Changes

- [#26](https://github.com/rigsmith/shiprig-action/pull/26) [`e16a143`](https://github.com/rigsmith/shiprig-action/commit/e16a143) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - A `release:hold` label on the version PR stops the action from updating its branch, so it can be edited by hand (`hold-label` / `holdLabel` names another label). Every run writes what it did to the job summary: the plan and the version PR, what was published and tagged, or why nothing happened. And a release from conventional commits, which consumes no changesets, now gets "released in" comments too, on the pull requests its changelog sections reference.
- [#28](https://github.com/rigsmith/shiprig-action/pull/28) [`3346a85`](https://github.com/rigsmith/shiprig-action/commit/3346a85) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - The `pr-status` sub-action runs on shiprig: its comment shows each package's new version and a changelog preview of the pull request's own entries, in any ecosystem shiprig supports. It no longer needs `@changesets/cli`.
- [#30](https://github.com/rigsmith/shiprig-action/pull/30) [`a943cc3`](https://github.com/rigsmith/shiprig-action/commit/a943cc3) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - `pr-status` previews with `shiprig version --changelog --since`, so a repository that also versions from conventional commits gets the PR's plan and changelog preview too, scoped to the PR's own commits and changesets, instead of a note. A PR that releases from its commits alone gets a "Release detected" comment.
- [#36](https://github.com/rigsmith/shiprig-action/pull/36) [`c746223`](https://github.com/rigsmith/shiprig-action/commit/c746223) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - pr-status warns about packages a PR changes that nothing in it releases. The comment names them under **Changed but not released**, the run gets a warning annotation, and the new `unreleased-packages` output lists them. A package named in one of the PR's changesets, `none` included, counts as decided. It's a warning only, and never fails the job.
- [#29](https://github.com/rigsmith/shiprig-action/pull/29) [`d3ba629`](https://github.com/rigsmith/shiprig-action/commit/d3ba629) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - shiprig-action now needs shiprig 1.21.0 or later, and checks for it before doing anything: an older shiprig fails with the minimum named, instead of partway through with a missing-command error. Update the job's shiprig install to 1.21.0.
- [#31](https://github.com/rigsmith/shiprig-action/pull/31) [`5ff3016`](https://github.com/rigsmith/shiprig-action/commit/5ff3016) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - The `select-mode`, `pack` and `publish` sub-actions run on shiprig: `select-mode` plans with `shiprig publish-plan`, `pack` builds with `shiprig pack`, and `publish` takes `pack-dir-artifact-id` and publishes exactly the packed files with `shiprig publish --from-pack-dir`, building nothing. The build → pack → publish job split now works beyond npm (NuGet too; cargo publishes from source, so it's refused at pack). The action no longer depends on `@changesets/cli`.

## 0.5.0

### Minor Changes

- [#24](https://github.com/rigsmith/shiprig-action/pull/24) [`166695c`](https://github.com/rigsmith/shiprig-action/commit/166695c) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - After a release, each pull request whose changeset shipped gets a "🚀 Released in" comment naming the package versions it went out in, linked to their releases. The pull requests are found from the changesets the version PR's merge consumed, so a monorepo PR is credited only for the packages its changeset named; re-runs don't comment twice, and a failed comment only warns. On by default; `comment-released-prs: false` (or `commentReleasedPrs` in `shiprig-action.jsonc`) turns it off.

## 0.4.0

### Minor Changes

- [#21](https://github.com/rigsmith/shiprig-action/pull/21) [`1f7317a`](https://github.com/rigsmith/shiprig-action/commit/1f7317a) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - Settings can live in a committed `shiprig-action.jsonc` (or `.json`) in `.github/`, `.changeset/` or the working directory: `prTitle`, `commitMessage`, `prDraft`, `prBaseBranch`, `publishOn`, `createGithubReleases`, `pushGitTags` and `pushWithGitCli`, each standing in for the input of the same name. An input set in the workflow wins over the file, and the file over the default. Unknown keys and wrong types fail the run; a JSON schema is in `schema/shiprig-action.json`.

### Patch Changes

- [#19](https://github.com/rigsmith/shiprig-action/pull/19) [`ad4e81a`](https://github.com/rigsmith/shiprig-action/commit/ad4e81a) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - A run whose commit the base branch has already moved past no longer touches the version PR, so a queued run that starts after a newer one can't reset `changeset-release/<base>` to older changes or reopen a version PR that was just merged. The "Nothing to publish" message no longer suggests starting the workflow by hand to workflows that can't be.

## 0.3.0

### Minor Changes

- [#17](https://github.com/rigsmith/shiprig-action/pull/17) [`5194ebe`](https://github.com/rigsmith/shiprig-action/commit/5194ebe) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - The publish path now runs only on the push that merges the version PR, and on runs started by hand (`workflow_dispatch`), instead of on every push with nothing pending. Set `publish-on: every-push` for the old behaviour. A tag the publish script already pushed is no longer reported as "Failed to create git tag … Reference already exists"; a tag the action can't push now fails the run instead of being assumed pushed.

## 0.2.0

### Minor Changes

- [#13](https://github.com/rigsmith/shiprig-action/pull/13) [`43fbc00`](https://github.com/rigsmith/shiprig-action/commit/43fbc00) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - The version PR's default title and commit message name what it releases: `chore: release 1.2.0` when everything shares one version, the packages by short name for up to three (`chore: release core@1.2.0, ui@0.5.0`), and a count beyond that. They were `Version Packages`; set `pr-title` and `commit-message` to keep that. A title or message you set still gets the ` (tag)` suffix in prerelease mode; the default doesn't need it, since the version already carries the tag.

## 0.1.0

### Minor Changes

- [#10](https://github.com/rigsmith/shiprig-action/pull/10) [`633d1ba`](https://github.com/rigsmith/shiprig-action/commit/633d1ba) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - First release: changesets/action driving [shiprig](https://rigsmith.dev) instead of the npm-only Changesets CLI. One version PR and one set of releases across every ecosystem shiprig supports, from changesets and/or conventional commits. Needs shiprig ≥ 1.20.0 in the job. The `select-mode`, `pack` and `pr-status` sub-actions aren't ported yet.
