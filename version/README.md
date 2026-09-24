# rigsmith/shiprig-action/version

This action versions packages with shiprig and creates or updates a pull request with the changes.

## Requirements

- Needs repo checked out and **shiprig ≥ 1.21.0** on `PATH` (or at `$SHIPRIG_BIN`); checked before anything runs
- [Job permissions][job-permissions]:
  - `contents: write`: to commit version changes
  - `pull-requests: write`: to create pull request
- [Workflow triggers][workflow-triggers]: _any_

> [!NOTE]
> In your repository settings, in `Actions > General`, also ensure the `Allow GitHub Actions to create and approve pull requests` option is enabled

## Usage

> [!TIP]
> See [the root README](../README.md) for a complete workflow and for installing shiprig.

## API

<!-- api-start -->

| Inputs                   | Description                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`           | The GitHub token to use for authentication. Defaults to the GitHub-provided token. To use a custom token, pass it explicitly to this input.                                                                                                                                                                                                                |
| `script`                 | The command to use to version packages                                                                                                                                                                                                                                                                                                                     |
| `commit-message`         | The commit message. Defaults to the pull request's default title. Can also be set as `commitMessage` in `shiprig-action.jsonc`; this input wins over the file.                                                                                                                                                                                             |
| `pr-title`               | The pull request title. Defaults to `chore: release` plus what it releases: `chore: release 1.2.0` when everything shares one version, `chore: release core@1.2.0, ui@0.5.0` for up to three packages, and `chore: release 5 packages` beyond that. Can also be set as `prTitle` in `shiprig-action.jsonc`; this input wins over the file.                 |
| `separate-pull-requests` | Open a version PR per release group (packages that must be versioned together) instead of one for everything, so packages can release on their own schedules, as release-please's `separate-pull-requests`. Needs shiprig 1.22.0. Defaults to `false`. Can also be set as `separatePullRequests` in `shiprig-action.jsonc`; this input wins over the file. |
| `hold-label`             | A label on the version PR that stops the action from updating its branch, so it can be edited by hand. Defaults to `release:hold`. Can also be set as `holdLabel` in `shiprig-action.jsonc`; this input wins over the file.                                                                                                                                |
| `pr-draft`               | Controls draft PR behavior. Use 'create' to create new version PRs as draft, or 'always' to also convert existing version PRs back to draft when updating them. Can also be set as `prDraft` in `shiprig-action.jsonc`; this input wins over the file.                                                                                                     |
| `pr-base-branch`         | Sets the base branch of the PR. Defaults to `github.ref_name`. Can also be set as `prBaseBranch` in `shiprig-action.jsonc`; this input wins over the file.                                                                                                                                                                                                 |
| `push-with-git-cli`      | Whether to use the Git CLI instead of the GitHub API to push release commits. Defaults to `false`. When using the GitHub API, commits are signed using GitHub's GPG key and attributed to the user or app that owns the `github-token`. Can also be set as `pushWithGitCli` in `shiprig-action.jsonc`; this input wins over the file.                      |
| `cwd`                    | The working directory to run shiprig (or the custom script) in. Defaults to the root of the repository.                                                                                                                                                                                                                                                    |

| Outputs      | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pr-number`  | The pull request number that was created or updated (with separate-pull-requests, the first group's)             |
| `pr-numbers` | A JSON array of every version pull request created or updated, one per release group with separate-pull-requests |

<!-- api-end -->

[job-permissions]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
[workflow-triggers]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
