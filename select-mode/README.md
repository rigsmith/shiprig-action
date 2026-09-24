# rigsmith/shiprig-action/select-mode

This action selects the mode to run a release workflow, on shiprig:

- `"version"`: a release is pending (from changesets, or from conventional commits when the repository versions from them). The workflow should version packages and create a pull request with the changes.
- `"publish"`: nothing is pending, and `shiprig publish-plan` lists packages whose version isn't on its registry yet, or whose git tag is missing. The workflow should publish them. The plan is uploaded as an artifact (`publish-plan-artifact-id`) for [pack](../pack/README.md).
- `"none"`: nothing to version or publish, including changesets that release nothing (empty, or naming only ignored packages). The workflow should do nothing.

## Requirements

- Needs repo checked out (with its tags, for the publish plan) and **shiprig ≥ 1.21.0** on `PATH` (or at `$SHIPRIG_BIN`); checked before anything runs
- [Job permissions][job-permissions]: _none_
- [Workflow triggers][workflow-triggers]: _any_

## Usage

> [!TIP]
> Check out [the docs](https://changesets.dev/guide/automating#how-do-i-run-the-version-and-publish-commands) to learn how to set up the version and publish workflow.

## API

<!-- api-start -->

| Inputs | Description                                                                             |
| ------ | --------------------------------------------------------------------------------------- |
| `cwd`  | The working directory to execute Changesets in. Defaults to the root of the repository. |

| Outputs                    | Description                                                                  |
| -------------------------- | ---------------------------------------------------------------------------- |
| `mode`                     | The mode to use for the current repo state: 'version', 'publish', or 'none'. |
| `publish-plan-artifact-id` | Artifact id for the generated publish plan when mode is `publish`            |

<!-- api-end -->

[job-permissions]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
[workflow-triggers]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
