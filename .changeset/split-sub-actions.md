---
"shiprig-action": minor
---

The `select-mode`, `pack` and `publish` sub-actions run on shiprig: `select-mode` plans with `shiprig publish-plan`, `pack` builds with `shiprig pack`, and `publish` takes `pack-dir-artifact-id` and publishes exactly the packed files with `shiprig publish --from-pack-dir`, building nothing. The build → pack → publish job split now works beyond npm (NuGet too; cargo publishes from source, so it's refused at pack). The action no longer depends on `@changesets/cli`.
