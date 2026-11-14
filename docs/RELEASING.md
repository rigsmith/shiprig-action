# Releasing shiprig-action

shiprig-action releases itself, with itself (`.github/workflows/release.yml`).

1. **Add a changeset** in each PR that changes behaviour: `shiprig add` (or
   `changerig add`), naming `shiprig-action`.
2. **Merge to main.** The release workflow opens or updates the **Version
   Packages** PR: `pnpm bump` runs `shiprig version` (bumps `package.json`,
   writes `CHANGELOG.md`) and points the READMEs' `@vN` examples at the release
   line.
3. **Merge the version PR** (`chore: release <version>`). The workflow runs `pnpm release`, which:
   - releases nothing if this version's tag is already on the remote, so a
     push without a new version never moves the release line forward; it
     only moves the `vN` branch and tag back onto that tag if a failed push
     or a hand edit left them elsewhere;
   - commits the built `dist/` on a detached release commit;
   - tags it `vX.Y.Z` with `shiprig tag`;
   - pushes the `vX.Y.Z` tag and force-pushes the `vN` branch and `vN` tag to
     that commit in one atomic push, so a refused ref leaves all three
     untouched (prereleases push only their `vX.Y.Z` tag);
   - only then reports the tag to the action through `CHANGESETS_OUTPUT`, so a
     failed push never leads to a release.

   The action then creates the GitHub release from the changelog entry. If a
   run pushed the tag but failed to create the release, the next run finds the
   tag without a release and reports it again, so the action creates it; the
   release line isn't moved.

Users reference the action as `rigsmith/shiprig-action@v0` (the release line,
kept as both a branch and a tag on the latest release), a release tag
(`@vX.Y.Z`), or that tag's full commit SHA, never `@main`: `dist/` exists only in
release commits.

## Requirements

- **The shipRig GitHub App**, installed on this repository with the repository
  permissions **Contents**, **Pull requests** and **Workflows**, all read and
  write (each token step fails if the installation lacks what it asks for),
  its client ID in the org variable `SHIPRIG_APP_CLIENT_ID` and its private
  key in the org secret `SHIPRIG_APP_PRIVATE_KEY`. The action opens and updates the version PR
  as the App (`shiprig[bot]`), so the PR's CI runs without **Approve workflows
  to run**, which a PR opened with `GITHUB_TOKEN` would need.
- The workflow mints two App tokens. The action's (Contents, Pull requests)
  opens the version PR and creates the GitHub release. The release script's
  git pushes (the release commit, the tags and the `vN` branch) use a second one
  (Contents, Workflows), passed as `RELEASE_GIT_TOKEN`: moving `vN` across
  commits that change `.github/workflows/` needs the Workflows permission,
  which the job's `GITHUB_TOKEN` can't have. The job's own token is read-only.
