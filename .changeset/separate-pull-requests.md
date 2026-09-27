---
"shiprig-action": minor
---

`separate-pull-requests: true` opens a version PR per release group (packages that must be versioned together: one changeset naming both, a dependency, a fixed or linked group, a shared version file) instead of one for everything, as release-please's `separate-pull-requests` does, so packages can release on their own schedules. Each group's branch is `changeset-release/<base>/<group>`; merging any of them publishes, a group's PR is closed once nothing in it is pending (unless held), and the new `pr-numbers` output lists them all. Needs shiprig 1.22.0.
