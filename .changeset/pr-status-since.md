---
"shiprig-action": minor
---

`pr-status` previews with `shiprig version --changelog --since`, so a repository that also versions from conventional commits gets the PR's plan and changelog preview too, scoped to the PR's own commits and changesets, instead of a note. A PR that releases from its commits alone gets a "Release detected" comment.
