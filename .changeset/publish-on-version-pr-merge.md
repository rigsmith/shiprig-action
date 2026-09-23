---
"shiprig-action": minor
---

The publish path now runs only on the push that merges the version PR, and on runs started by hand (`workflow_dispatch`), instead of on every push with nothing pending. Set `publish-on: every-push` for the old behaviour. A tag the publish script already pushed is no longer reported as "Failed to create git tag … Reference already exists"; a tag the action can't push now fails the run instead of being assumed pushed.
