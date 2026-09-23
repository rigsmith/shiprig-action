---
"shiprig-action": minor
---

A `release:hold` label on the version PR stops the action from updating its branch, so it can be edited by hand (`hold-label` / `holdLabel` names another label). Every run writes what it did to the job summary: the plan and the version PR, what was published and tagged, or why nothing happened. And a release from conventional commits, which consumes no changesets, now gets "released in" comments too, on the pull requests its changelog sections reference.
