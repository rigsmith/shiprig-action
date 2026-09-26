---
"shiprig-action": minor
---

pr-status warns about packages a PR changes that nothing in it releases. The comment names them under **Changed but not released**, the run gets a warning annotation, and the new `unreleased-packages` output lists them. A package named in one of the PR's changesets, `none` included, counts as decided. It's a warning only, and never fails the job.
