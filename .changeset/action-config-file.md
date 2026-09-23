---
"shiprig-action": minor
---

Settings can live in a committed `shiprig-action.jsonc` (or `.json`) in `.github/`, `.changeset/` or the working directory: `prTitle`, `commitMessage`, `prDraft`, `prBaseBranch`, `publishOn`, `createGithubReleases`, `pushGitTags` and `pushWithGitCli`, each standing in for the input of the same name. An input set in the workflow wins over the file, and the file over the default. Unknown keys and wrong types fail the run; a JSON schema is in `schema/shiprig-action.json`.
