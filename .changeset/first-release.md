---
"shiprig-action": minor
---

A `releaseAs` entry naming a package's own current version, while that version is unreleased, is now a first release at the version on disk. The action enters version mode for it even with no changesets, and passes `--release-as <pkg>=<version>` to shiprig, which writes the changelog entry without bumping. The version PR is titled for that version, and the job summary shows it as a first release. The version counts as unreleased while the package's changelog has no entry for it and its tag doesn't exist, so once the version PR merges, the package publishes. The `select-mode` sub-action does the same. This needs a shiprig release that supports `--release-as` at the current version.
