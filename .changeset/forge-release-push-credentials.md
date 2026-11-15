---
"shiprig-action": patch
---

Combined GitHub releases work in a checkout with no git credentials (`actions/checkout` with `persist-credentials: false`). `shiprig forge-release` pushes the combined tag (`v${version}`) with plain `git push`, which failed there with `tag v0.2.0: pushing: exit status 128` after the publish and the per-package tags had gone through. The action now gives that one process its `github-token` for the push, as a command-scoped `http.extraheader` in git's environment (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, for the GitHub server URL and each `origin` push URL), the same way `push-with-git-cli` pushes. The header is masked in the log and never written to `.git/config`, and it replaces a header the checkout persisted rather than adding a second one. Other shiprig calls, and `forge-release --dry-run`, get no push credentials. Nothing changes in what a workflow must configure.
