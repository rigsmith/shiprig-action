# Releasing shiprig-action

shiprig-action releases itself, with itself (`.github/workflows/release.yml`).

1. **Add a changeset** in each PR that changes behaviour: `shiprig add` (or
   `changerig add`), naming `shiprig-action`.
2. **Merge to main.** The release workflow opens or updates the **Version
   Packages** PR: `pnpm bump` runs `shiprig version` (bumps `package.json`,
   writes `CHANGELOG.md`) and points the READMEs' `@vN` examples at the release
   line.
3. **Merge the version PR** (`chore: release <version>`). The workflow runs `pnpm release`, which:
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

- **The shipRig GitHub App**, installed on this repository with the repository
  permissions **Contents: read and write** and **Pull requests: read and
  write** (the token step asks for both and fails if the installation lacks
  either), its client ID in the org variable `SHIPRIG_APP_CLIENT_ID` and its
  private key in the org secret `SHIPRIG_APP_PRIVATE_KEY`. The action opens and updates the version PR
  as the App (`shiprig[bot]`), so the PR's CI runs without **Approve workflows
  to run**, which a PR opened with `GITHUB_TOKEN` would need.
- The release script's git pushes (the release commit, the tag and the `vN`
  branch) use the job's `GITHUB_TOKEN`, which has `contents: write`, passed as
  `RELEASE_GIT_TOKEN`. The action hands the script the App token as
  `GITHUB_TOKEN`, which it uses only to read the GitHub release.
