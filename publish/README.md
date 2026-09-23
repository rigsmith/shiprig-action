# rigsmith/shiprig-action/publish

This action publishes packages with shiprig (by default `shiprig publish --yes`), then pushes the git tags it reports and creates their GitHub releases.

Publishing from a pack directory isn't supported yet: shiprig has no `publish --from-pack-dir`, so `pack-dir-artifact-id` is rejected before anything is downloaded, whether or not a custom `script` is given.

## Requirements

- Needs repo checked out and **shiprig ≥ 1.20.0** on `PATH` (or at `$SHIPRIG_BIN`)
- [Job permissions][job-permissions]:
  - `contents: write`: to push the git tags and create GitHub releases
  - `id-token: write`: if using [trusted publishing](https://docs.npmjs.com/trusted-publishers), which npm only accepts from GitHub-hosted runners
- [Workflow triggers][workflow-triggers]: _any_

## Usage

> [!TIP]
> See [the root README](../README.md) for a complete workflow and for installing shiprig.

## API

<!-- api-start -->

| Inputs                   | Description                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`           | The GitHub token to use for authentication. Defaults to the GitHub-provided token. To use a custom token, pass it explicitly to this input.                                                             |
| `script`                 | The command to use to publish packages                                                                                                                                                                  |
| `pack-dir-artifact-id`   | Not supported yet: shiprig can't publish from a pack directory, so setting this fails the step before anything is downloaded. Publish with the built-in `shiprig publish` or a custom `script` instead. |
| `create-github-releases` | Whether to create Github releases after publish                                                                                                                                                         |
| `push-git-tags`          | Whether to create git tags after publish. If `create-github-releases` is set to `true`, this option will also always be `true`.                                                                         |
| `cwd`                    | The working directory to execute Changesets in. Defaults to the root of the repository.                                                                                                                 |

| Outputs              | Description                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published`          | A "true" or "false" string value to indicate whether the publish script reported any tag (a `git-tag` event through CHANGESETS_OUTPUT). It reflects those reports, not a registry check.                                                            |
| `published-packages` | A JSON array of the packages whose tags the publish script reported (a `git-tag` event through CHANGESETS_OUTPUT), each at its version when the script ran, e.g. `[{"name": "@xx/xx", "version": "1.2.0"}, {"name": "@xx/xy", "version": "0.8.9"}]` |

<!-- api-end -->

[job-permissions]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
[workflow-triggers]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
