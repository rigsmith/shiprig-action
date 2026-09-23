# rigsmith/shiprig-action/pr-status

This action generates the changesets status in PRs: whether the PR has changeset files, which packages they release and at what version, and a **changelog preview** of the entries the PR's own changesets add.

It runs on shiprig, so it covers every ecosystem shiprig supports, not only npm. The plan comes from `shiprig status --since <base>` and the preview from `shiprig version --changelog`, both limited to the changesets the PR adds or edits. Changesets already pending on the base branch stay out of both.

It requires the repo to be checked out, and will automatically fetch the PR head ref into a temporary detached worktree in order to infer the changed files and packages.

## Requirements

- Needs repo checked out
- **shiprig ≥ 1.20.0** on `PATH` (or at `$SHIPRIG_BIN`), as for the [root action](../README.md#installing-shiprig)
- [Job permissions][job-permissions]: _none_
- [Workflow triggers][workflow-triggers]:
  - [`pull_request`][trigger-pull-request]
  - [`pull_request_target`][trigger-pull-request-target]

> [!CAUTION]
> **Do not run untrusted code** when using the `pull_request_target` event.
>
> `pull_request_target` can be useful to support PRs from forks, however it enables write permissions by default which can be a security risk if untrusted code is executed and the permissions aren't scoped down.

[job-permissions]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions
[workflow-triggers]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
[trigger-pull-request]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request
[trigger-pull-request-target]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target

## Usage

> [!TIP]
> Check out [the docs](https://changesets.dev/guide/automating#non-blocking) to learn how to set up commenting changesets status on PRs.

## API

<!-- api-start -->

Inputs: _none_

| Outputs        | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| `comment-body` | The generated comment body to present the changesets status in PRs. |

<!-- api-end -->
