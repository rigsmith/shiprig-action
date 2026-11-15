---
"shiprig-action": patch
---

The action's own GitHub releases are titled after their tag again (`v<version>`), not `shiprig-action@0.8.1` as 0.8.1's was. The action releases itself with the shiprig pinned in its lockfile, now 1.28.0, whose `shiprig forge-release` titles each per-package release after its tag. Nothing changes for workflows that use the action.
