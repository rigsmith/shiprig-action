---
"shiprig-action": patch
---

Packages released in lockstep under one shared tag (`"tagTemplate": "v${version}"`) now get their first release and their changelog check. A `v<version>` tag used to be matched to a package only when exactly one package was at that version, so a shared `v1.0.0` covering several packages matched none of them: `releaseAs` at the version on disk opened no version PR ("Nothing to publish"), and a missing changelog entry went unnoticed before publishing. The tag now covers every package at its version; `<name>@<version>` tags work as before.
