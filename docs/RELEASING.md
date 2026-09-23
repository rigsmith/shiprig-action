# Releasing shiprig-action

shiprig-action releases itself, with itself (`.github/workflows/release.yml`).

1. **Add a changeset** in each PR that changes behaviour: `shiprig add` (or
   `changerig add`), naming `shiprig-action`.
2. **Merge to main.** The release workflow opens or updates the **Version
   Packages** PR: `pnpm bump` runs `shiprig version` (bumps `package.json`,
   writes `CHANGELOG.md`) and points the READMEs' `@vN` examples at the release
   line.
3. **Merge the Version Packages PR.** The workflow runs `pnpm release`, which:
   - does nothing if this version's tag is already on the remote, so a push
     without a new version never moves the release line;
   - commits the built `dist/` on a detached release commit;
   - tags it `vX.Y.Z` with `shiprig tag`, which reports the tag to the action
     through `CHANGESETS_OUTPUT`;
   - force-pushes the `vN` branch to that commit (prereleases push only the tag).

   The action then creates the GitHub release from the changelog entry.

Users reference the action as `rigsmith/shiprig-action@v0` (the release line
branch) or `@v0.1.0` (a tag), never `@main`: `dist/` exists only in release
commits.

## Requirements

- **Settings → Actions → General → "Allow GitHub Actions to create and approve
  pull requests"** must be on, because the workflow opens the version PR with the
  default `GITHUB_TOKEN`.
- A version PR opened with `GITHUB_TOKEN` doesn't trigger other workflows, so CI
  doesn't run on it by itself. It only changes the version, the changelog and the
  READMEs; to run CI anyway, close and reopen it. Upstream uses a GitHub App
  token for this, which the workflow can adopt later.
