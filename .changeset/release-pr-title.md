---
"shiprig-action": minor
---

The version PR's default title and commit message name what it releases: `chore: release 1.2.0` when everything shares one version, the packages by short name for up to three (`chore: release core@1.2.0, ui@0.5.0`), and a count beyond that. They were `Version Packages`; set `pr-title` and `commit-message` to keep that. A title or message you set still gets the ` (tag)` suffix in prerelease mode; the default doesn't need it, since the version already carries the tag.
