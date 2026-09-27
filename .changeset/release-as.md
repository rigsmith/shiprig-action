---
"shiprig-action": minor
---

`releaseAs` in `shiprig-action.jsonc` releases a package at an exact version, as release-please's `release-as` does: `{ "releaseAs": { "my-lib": "2.0.0" } }` puts 2.0.0 in the version PR. It applies while the package is releasing and below that version, and is skipped once the package reaches it, so the entry can stay in the file. It waits out prereleases, and can't be combined with a custom `version-script`.
