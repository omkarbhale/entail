# Let a repo use a branch other than the forge's default as its base branch

Some projects treat a branch other than the forge's default branch as their default: work starts from that branch and merges back into it. entail always uses the forge's default branch, so on such a project it does the wrong thing:

- It follows only PRs and merge requests that target the forge's default branch (`src/watch.ts`, and the target-branch filters in `src/forge/gitlab.ts`), so a PR into the working branch is never judged or merged.
- It reads `VISION.md`, the repo it judges issues against, and the base of a PR's diff from the forge's default branch (`src/vision.ts`, `src/mirror.ts`, `src/watch.ts`), so the vision and code on the working branch are not seen.
- It reads recent checks from the forge's default branch's pipelines.

The owner should be able to set a base branch per repo, on the command line and on the board, that entail uses everywhere it uses the default branch today: what it reads, which PRs it follows, what it diffs against and where it merges. Unset, it stays the forge's default branch, so repos already enrolled behave as they do now.

GitHub and GitLab may not treat a closing keyword such as `Closes #n` as a link when the PR targets a branch other than the default, which is how entail matches a PR to its issue today. A repo with a base branch set may need another match, such as the issue number in the PR's branch name, which is a forge fact rather than the PR's own claim (see #234).

It should work the same on GitHub and GitLab.
