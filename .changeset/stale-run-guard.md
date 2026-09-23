---
"shiprig-action": patch
---

A run whose commit the base branch has already moved past no longer touches the version PR, so a queued run that starts after a newer one can't reset `changeset-release/<base>` to older changes or reopen a version PR that was just merged. The "Nothing to publish" message no longer suggests starting the workflow by hand to workflows that can't be.
