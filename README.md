# shiprig release

A GitHub Action that automates releases with [shiprig](https://rigsmith.dev), in
any ecosystem shiprig supports (npm, .NET, Go, Rust and more), from
[changesets](https://changesets.dev) and/or conventional commits.

It's a fork of [changesets/action](https://github.com/changesets/action) with the
same flow:

1. While releases are pending, it keeps a **version PR** open (branch
   `changeset-release/<base>`) that bumps versions and writes changelogs, and
   updates it as more changes land.
2. When that PR merges, it **publishes**, pushes the **git tags**, and creates a
   **GitHub release** for each package that has a changelog, using its changelog
   entry as the release notes.

What differs is behind it: the Changesets CLI only knows npm, while shiprig
versions, publishes and tags every ecosystem it discovers, and can take the
release from conventional commits instead of, or as well as, changeset files.

## Requirements

- **shiprig ≥ 1.20.0** on `PATH` in the job (or at `$SHIPRIG_BIN`). The action
  doesn't install it; see [Installing shiprig](#installing-shiprig).
- The repository checked out with enough history for shiprig to find its last
  release tags (`fetch-depth: 0` is simplest).
- [Job permissions][job-permissions]:
  - `contents: write`: to commit version changes and push tags
  - `pull-requests: write`: to open and update the version PR
  - `id-token: write`: if your publish uses trusted publishing (OIDC)
- In your repository settings, under `Actions > General`, enable **Allow GitHub
  Actions to create and approve pull requests**.

## Usage

<a id="with-publishing"></a>

### A version PR, publishing when it merges

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency: ${{ github.workflow }}-${{ github.ref }}

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v6
        with:
          node-version: 22

      - name: Install shiprig
        run: npm install -g @rigsmith/shiprig@1.20.0

      - uses: rigsmith/shiprig-action@v0
        with:
          publish-script: shiprig publish --yes
        env:
          # Whatever your registries need, e.g.:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NUGET_API_KEY: ${{ secrets.NUGET_API_KEY }}
```

For npm, shiprig publishes with `NPM_TOKEN`, or with trusted publishing (OIDC)
when the job has `id-token: write`. Trusted publishing signs provenance, which
npm only accepts from **GitHub-hosted** runners: on a self-hosted runner (which
includes services like Blacksmith) the publish fails with `E422`.

Leave out `publish-script` to only manage the version PR, and publish some
other way.

The action sets `CHANGESETS_OUTPUT` to a file before running `publish-script`.
`shiprig publish` writes an event there for each git tag it creates, and the
action reads them back to push exactly those tags and create their GitHub
releases. A custom script needs to run `shiprig publish` (or `shiprig tag`)
somewhere, or the action won't know what was released.

### Conventional commits

shiprig reads the versioning source from its changeset config. To release from
conventional commits (`feat:`, `fix:`, `feat!:`) instead of changeset files, set:

```jsonc
// .changeset/config.json
{
  "versioning": { "source": "commits" },
}
```

`both` takes changeset files and commits together. Nothing changes in the
workflow: the action asks shiprig what's pending either way.

### Prereleases

`shiprig pre enter next` puts the repo in prerelease mode; the version PR then
releases `-next.N` versions, and its title says so. After `shiprig pre exit`,
the next version PR graduates everything to a stable release.

### Using a custom GitHub token

Pass it through the `github-token` input:

```yaml
with:
  github-token: ${{ secrets.CUSTOM_GITHUB_TOKEN }}
```

Setting a `GITHUB_TOKEN` environment variable does not configure the action.
A version PR opened with the default token gets its `pull_request` checks in an
approval-required state (start them with **Approve workflows to run**); with a
token from a GitHub App or a personal account they run straight away.

## Installing shiprig

Any of these puts shiprig on `PATH`. Pin the version, so a release job always
runs the shiprig it was tested with.

- **npm** (any runner with Node; published with provenance):

  ```yaml
  - run: npm install -g @rigsmith/shiprig@1.20.0
  ```

- **The install script** (Linux and macOS runners):

  ```yaml
  - run: |
      curl -fsSL https://rigsmith.sh | RIGSMITH_VERSION=v1.20.0 sh -s shiprig
      echo "$HOME/.local/bin" >> "$GITHUB_PATH"
  ```

See [rigsmith.dev](https://rigsmith.dev/guide/installation) for Homebrew,
winget and the rest.

## Outputs

- `has-changesets`: whether changeset files exist (counting the ones waiting in
  `.changeset/pre/` after `pre exit`). A release that comes only from
  conventional commits doesn't set it.
- `published`, `published-packages`: the packages whose tags `publish-script`
  reported through `CHANGESETS_OUTPUT`. They reflect those reports, not a check
  against the registry.
- `pr-number`: the version PR opened or updated.

## Sub-actions

The root action above combines the steps; the sub-actions split them across jobs.

| Sub-action                                                                                                 | Status                                                                |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`version`](./version/README.md)                                                                           | Runs on shiprig                                                       |
| [`publish`](./publish/README.md)                                                                           | Runs on shiprig; publishing from a pack directory isn't supported yet |
| [`pr-comment`](./pr-comment/README.md)                                                                     | Works as is (doesn't use a release tool)                              |
| [`select-mode`](./select-mode/README.md), [`pack`](./pack/README.md), [`pr-status`](./pr-status/README.md) | **Not ported yet:** these still run the Changesets CLI                |

The split flow (select-mode → pack → publish) is phase 4 in
[docs/DESIGN.md](docs/DESIGN.md).

## Migrating from changesets/action

1. Install shiprig in the job (see above). shiprig reads the same
   `.changeset/` directory, changeset files and `config.json`, so nothing there
   needs to change.
2. Replace `uses: changesets/action@v2` with `uses: rigsmith/shiprig-action@v0`.
3. If you set `version-script` or `publish-script` to `changeset …` commands,
   switch them to `shiprig version --yes` and `shiprig publish --yes`, or drop
   `version-script` (that's the default).

The version branch name stays `changeset-release/<base>`, so changeset-bot and
anything else that looks for it keep working.

## API

<!-- api-start -->

| Inputs                   | Description                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`           | The GitHub token to use for authentication. Defaults to the GitHub-provided token. To use a custom token, pass it explicitly to this input.                                                                                                                                           |
| `publish-script`         | The command to use to build and publish packages, e.g. `shiprig publish --yes`. The action sets CHANGESETS_OUTPUT to a file; `shiprig publish` (or `shiprig tag`) writes an event there for each tag it creates, and the action reads them back to push the tags and create releases. |
| `version-script`         | The command to update versions, edit CHANGELOGs, and consume changesets. Defaults to `shiprig version --yes`                                                                                                                                                                          |
| `commit-message`         | The commit message. Default to `Version Packages`                                                                                                                                                                                                                                     |
| `pr-title`               | The pull request title. Default to `Version Packages`                                                                                                                                                                                                                                 |
| `pr-draft`               | Controls draft PR behavior. Use 'create' to create new version PRs as draft, or 'always' to also convert existing version PRs back to draft when updating them.                                                                                                                       |
| `pr-base-branch`         | Sets the base branch of the PR. Defaults to `github.ref_name`.                                                                                                                                                                                                                        |
| `create-github-releases` | Whether to create GitHub releases after publish                                                                                                                                                                                                                                       |
| `push-git-tags`          | Whether to create git tags after publish. If `create-github-releases` is set to `true`, this option will also always be `true`.                                                                                                                                                       |
| `push-with-git-cli`      | Whether to use the Git CLI instead of the GitHub API to push release commits and tags. Defaults to `false`. When using the GitHub API, commits and tags are signed using GitHub's GPG key and attributed to the user or app that owns the `github-token`.                             |
| `cwd`                    | The working directory to run shiprig in. Defaults to the root of the repository.                                                                                                                                                                                                      |

| Outputs              | Description                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published`          | A "true" or "false" string value to indicate whether the publish script reported any tag (a `git-tag` event through CHANGESETS_OUTPUT, which `shiprig publish` and `shiprig tag` write). It reflects those reports, not a registry check. |
| `published-packages` | A JSON array of the packages whose tags the publish script reported, e.g. `[{"name": "@xx/xx", "version": "1.2.0"}, {"name": "@xx/xy", "version": "0.8.9"}]`                                                                              |
| `has-changesets`     | A "true" or "false" string value about whether changeset files exist (including those waiting in .changeset/pre/ after `pre exit`). A release from conventional commits alone doesn't set it.                                             |
| `pr-number`          | The pull request number that was created or updated                                                                                                                                                                                       |

<!-- api-end -->

[job-permissions]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
