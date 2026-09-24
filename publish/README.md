# rigsmith/shiprig-action/publish

This action publishes packages with shiprig (by default `shiprig publish --yes`), then pushes the git tags it reports and creates their GitHub releases.

With `pack-dir-artifact-id`, it downloads the directory [pack](../pack/README.md) built and runs `shiprig publish --from-pack-dir`: exactly those files are published, in dependency order and under their npm dist-tag, building nothing, and each must still match the sha256 pack recorded. A custom `script` isn't given the directory, so the two can't be combined.

## Requirements

- Needs repo checked out and **shiprig ≥ 1.21.0** on `PATH` (or at `$SHIPRIG_BIN`); checked before anything runs
- [Job permissions][job-permissions]:
  - `contents: write`: to push the git tags and create GitHub releases
  - `pull-requests: write`: to comment "released in" on the pull requests
    whose changesets shipped (or set `comment-released-prs: false`)
  - `id-token: write`: if using [trusted publishing](https://docs.npmjs.com/trusted-publishers), which npm only accepts from GitHub-hosted runners
- [Workflow triggers][workflow-triggers]: _any_

## Usage

> [!TIP]
> See [the root README](../README.md) for a complete workflow and for installing shiprig.

## API

<!-- api-start -->

| Inputs                   | Description                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`           | The GitHub token to use for authentication. Defaults to the GitHub-provided token. To use a custom token, pass it explicitly to this input.                      |
| `script`                 | The command to use to publish packages                                                                                                                           |
| `pack-dir-artifact-id`   | The artifact id [pack](../pack/README.md) output: publish those files with `shiprig publish --from-pack-dir`, building nothing. Can't be combined with `script`. |
| `create-github-releases` | Whether to create Github releases after publish                                                                                                                  |
| `push-git-tags`          | Whether to create git tags after publish. If `create-github-releases` is set to `true`, this option will also always be `true`.                                  |
| `cwd`                    | The working directory to run shiprig (or the custom script) in. Defaults to the root of the repository.                                                          |

| Outputs              | Description                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published`          | A "true" or "false" string value to indicate whether the publish script reported any tag (a `git-tag` event through CHANGESETS_OUTPUT). It reflects those reports, not a registry check.                                                            |
| `published-packages` | A JSON array of the packages whose tags the publish script reported (a `git-tag` event through CHANGESETS_OUTPUT), each at its version when the script ran, e.g. `[{"name": "@xx/xx", "version": "1.2.0"}, {"name": "@xx/xy", "version": "0.8.9"}]` |

<!-- api-end -->

[job-permissions]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
[workflow-triggers]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
