---
"shiprig-action": minor
---

A missing changelog entry now fails the run before anything is published, not after. The action asks `shiprig tag --dry-run` what the publish would tag, and if a package's `CHANGELOG.md` has no entry for that version, the run stops there and names each such package. It used to surface only at the package's GitHub release, once the packages were published and the tags pushed, and the release got the whole changelog as its notes. The new `release-notes-fallback` input (`releaseNotesFallback` in `shiprig-action.jsonc`) chooses what happens instead: `error` (the default), `generate` (GitHub writes the release notes from the merged PRs) or `skip` (no release). The `publish` sub-action takes it too.
