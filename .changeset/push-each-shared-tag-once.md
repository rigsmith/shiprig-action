---
"shiprig-action": patch
---

A tag several packages share (`"tagTemplate": "v${version}"` in a lockstep repo) is pushed once, however many `git-tag` events name it. A shiprig that reports one event per package of a shared tag no longer fails the run after publishing, with each extra push of the same tag refused as "Reference already exists". Every package of the tag still counts as released, in `published-packages`, the job summary and the "released in" comments. When the action creates the GitHub releases itself, a shared tag gets one release, with a `## <name>@<version>` section per package as shiprig's combined release writes them.
