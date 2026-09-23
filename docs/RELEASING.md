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
   - tags it `vX.Y.Z` with `shiprig tag`;
   - force-pushes the `vN` branch to that commit (prereleases push only the tag);
   - only then reports the tag to the action through `CHANGESETS_OUTPUT`, so a
     failed push never leads to a release.

   The action then creates the GitHub release from the changelog entry. If a
   run pushed the tag but failed to create the release, the next run finds the
   tag without a release and reports it again, so the action creates it; the
   release line isn't moved.

Users reference the action as `rigsmith/shiprig-action@v0` (the release line
branch) or `@v0.1.0` (a tag), never `@main`: `dist/` exists only in release
commits.

## Requirements

- **Settings → Actions → General → "Allow GitHub Actions to create and approve
  pull requests"** must be on, because the workflow opens the version PR with the
  default `GITHUB_TOKEN`.
- A version PR opened or updated with `GITHUB_TOKEN` gets its `pull_request`
  workflow runs (CI) in an **approval-required** state: someone with write
  access starts them with **Approve workflows to run** on the PR. Upstream uses
  a GitHub App token, which avoids the approval step; the workflow can adopt one
  later.
