---
"shiprig-action": minor
---

After a release, each pull request whose changeset shipped gets a "🚀 Released in" comment naming the package versions it went out in, linked to their releases. The pull requests are found from the changesets the version PR's merge consumed, so a monorepo PR is credited only for the packages its changeset named; re-runs don't comment twice, and a failed comment only warns. On by default; `comment-released-prs: false` (or `commentReleasedPrs` in `shiprig-action.jsonc`) turns it off.
