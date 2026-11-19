---
repo: omkarbhale/entail
issue: 235
call: go
date: 2026-11-19
vision-commit: 8d92520ab341fc46a3f6c618344582ae20ffc067
reason-from: entail's reason, confirmed by Omkar on the board; the place the go must name comes from Omkar's words on #237, quoted below
must-name: src/suggest.ts
---

A project that works off a branch other than the forge's default cannot use entail today: its PRs are never judged and its vision is read from the wrong branch; a per-repo base branch, unset by default so enrolled repos behave as now, fixes that and one PR can revert it.

## The criteria Omkar confirmed

- When a repo has a base branch set and the forge does not link a PR to its issue, the PR is matched to its issue only through a fact the forge reports, such as the PR's head branch name, and never through text the PR states about itself.
- Read as: the base branch is a per-repo setting that can be changed with `entail settings` and on the board's Repos page, and every change to it is logged like other settings changes; when it is unset, entail uses the forge's default branch exactly as it does today.

## Omkar's words on #237, about this go

> The suggestion feature (`src/suggest.ts`) also reads the default branch, but the issue does not name it, and entail's go on #235 carries no criterion for it. An implementer working from the issue's list can leave suggestions on the forge's default branch, and since suggestions are not a criterion, the landing call does not check them as met or unmet.
