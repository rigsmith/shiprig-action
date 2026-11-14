---
"shiprig-action": patch
---

Each release now moves a `v0` tag to the release commit as well as the `v0` branch, so `uses: rigsmith/shiprig-action@v0` follows the latest `v0.x.y` as a tag, the way GitHub's guidance for actions expects. The README now covers pinning a full commit SHA.
