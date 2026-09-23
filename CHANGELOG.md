# shiprig-action

## 0.2.0

### Minor Changes

- [#13](https://github.com/rigsmith/shiprig-action/pull/13) [`43fbc00`](https://github.com/rigsmith/shiprig-action/commit/43fbc00) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - The version PR's default title and commit message name what it releases: `chore: release 1.2.0` when everything shares one version, the packages by short name for up to three (`chore: release core@1.2.0, ui@0.5.0`), and a count beyond that. They were `Version Packages`; set `pr-title` and `commit-message` to keep that. A title or message you set still gets the ` (tag)` suffix in prerelease mode; the default doesn't need it, since the version already carries the tag.

## 0.1.0

### Minor Changes

- [#10](https://github.com/rigsmith/shiprig-action/pull/10) [`633d1ba`](https://github.com/rigsmith/shiprig-action/commit/633d1ba) Thanks [@JohnCampionJr](https://github.com/JohnCampionJr)! - First release: changesets/action driving [shiprig](https://rigsmith.dev) instead of the npm-only Changesets CLI. One version PR and one set of releases across every ecosystem shiprig supports, from changesets and/or conventional commits. Needs shiprig ≥ 1.20.0 in the job. The `select-mode`, `pack` and `pr-status` sub-actions aren't ported yet.
