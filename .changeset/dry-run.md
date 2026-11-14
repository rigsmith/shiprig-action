---
"shiprig-action": minor
---

`dry-run: true` rehearses a run without changing anything. The version path runs `shiprig version --dry-run` and logs the version PR it would open or update. The publish path checks changelog entries, runs `shiprig publish --dry-run` and logs the tags and releases it would create. Nothing is committed, pushed, tagged, published or released, and no PR is opened or updated. A custom `version-script` or `publish-script` isn't run in a dry run, because the action can't know the script honors a dry-run flag; shiprig's own dry run stands in for it.
