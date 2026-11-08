# Forges sit behind one adapter, reached through the owner's CLIs, with repository content read from git

GitHub and GitLab are equally first-class, and self-hosted GitLab is a first-class case with gitlab.com on the same code path (owner). To keep them equal, entail splits what it reads into two layers:

- **Repository content** comes from a local, fetch-only git mirror of each enrolled repo. That covers VISION.md and its commit, `Vision-Origin` trailers (ADR-0004), CI files for proposing generic criteria (ADR-0014), and each PR's diff and changed paths at the checked head. The PR head is fetched from `refs/pull/<n>/head` or `refs/merge-requests/<iid>/head`.
- **The social layer** goes through one `Forge` interface with exactly two adapters, GitHub and GitLab. That covers issues, PRs, comments, labels, closing, merging, checks and identity.

Nothing above the adapter names a forge. Every adapter call runs through the owner's own CLI (`gh api --hostname <host>` or `glab api --hostname <host>`), so entail never holds or stores a token.

git is already forge-neutral. Diffs and changed paths are therefore computed the same way on both forges, and are never truncated as the forges' diff APIs truncate large changes, so "changes path" and "leaves path" mechanical checks stay exact. The CLIs already handle the owner's keyring, token refresh, and a self-hosted instance's protocol, API host and certificate authority. Keeping tokens out of entail also keeps them out of the records repo (ADR-0009).

## Considered options

- **Reading content through each forge's contents, compare and changes APIs**: rejected. It doubles the adapter surface, and large diffs come back truncated on both forges.
- **An in-process HTTP client using a token read from the CLI**: rejected for MVP-1. It is faster per call, but entail would have to reimplement each CLI's host configuration for self-hosted GitLab. It stays possible behind the transport seam without touching the adapters.
- **Forge-specific branches in the core, or a third-party "unified forge" library**: rejected. The first lets the forges drift apart, and the second's model of checks and merges is not ADR-0013's.

## Consequences

- **The mirror.** It is fetch-only, so entail still never pushes to a project's repo (ADR-0009). git authenticates through the same CLI as the API.
- **The forge setting.** A repo's forge setting is `forge` (`github` or `gitlab`, stated explicitly, never guessed from the host), `host` and `path`. It has no credentials and no base URL.
  - At enrollment, entail resolves the forge's numeric project id and keys its records on forge, host and project id, so a renamed or transferred repo keeps its records.
  - gitlab.com is simply the GitLab host `gitlab.com`.
- **The account.** At enrollment, entail records the numeric id of the account the CLI is logged in as for that host. If the CLI later reports a different account, or none, entail does nothing in that repo rather than act as someone else.
- **Identity.** An actor is forge, host and numeric user id, with the username kept for display. Every identity comparison uses the id:
  - the owner's own issues;
  - a `/entail` comment;
  - a PR author's evidence;
  - "owner plus listed executors", whose list is resolved to ids when it is saved.
- **Change detection.** Each adapter answers "what changed since this cursor" in its cheapest way, and the core deduplicates by kind, id and update time.
  - GitHub uses ETag-conditional reads of issues and issue comments. A 304 costs no rate limit, and `gh api` exits 1 on it, so the transport reads the HTTP status, not the exit code.
  - GitLab has no conditional requests and no time filter on notes. entail re-reads issues and merge requests updated within an overlap window of at least two minutes before the cursor, because GitLab updates an issue's last-update time at most once a minute. It then pages each touched one's notes newest first, until it reaches notes it has already seen.
  - Cursors are operational state, not records, so losing them costs only a re-scan. Poll intervals are decided with the shape of the local process.
- **Checks.** The adapter reports the checks at one sha, and which of them the forge requires.
  - **GitHub**: check runs and commit statuses together. Neutral and skipped results count as passed. The required checks are the default branch's rules.
  - **GitLab**: the jobs of the pipeline GitLab attaches to the merge request's current head, whose sha must match. A job with `allow_failure` follows GitLab's own pipeline status. That pipeline is required when "pipelines must succeed" is on.
  - A check that a frozen criterion or generic criterion names but that has not reported yet is pending, so a landing check never runs before CI has registered.
  - With no named checks and no checks at all, every check has finished. This gives ADR-0013's merge guard and ADR-0014's trigger one meaning on both forges.
- **Writes.** The adapter offers four writes: a comment on an issue or PR, adding or removing a label, closing an issue, and merging a PR pinned to a sha.
  - **The comment rules.** The comment writer refuses any body that lacks the attribution line or hidden marker, or that has a line starting with `/`. Each comment is recorded as an intent before it is posted and by its forge id after. After a crash in between, entail finds its own comment by the hidden marker instead of posting it twice.
  - **Labels.** A missing `entail:` label is created by first use.
  - **Merges.** GitHub merges through `merge-async` with `sha` and without bypassing rules. GitLab merges through `merge` with `sha` and without `auto_merge`. Any outcome other than merged is a refusal (ADR-0014).
  - **Wording.** The adapter supplies "merge request" for GitLab comments.
- **Self-hosted GitLab.** entail reads the instance's version at enrollment and refuses one older than 15.6, the first version with `detailed_merge_status`. It relies on nothing above the Free/CE tier, so Premium features such as required approvals or merge trains can only make the forge refuse a merge. Self-hosted is covered by adapter tests on recorded responses with a non-gitlab.com host and a CE version string (ADR-0010). gitlab.com runs the live acceptance test on the same code.
- **GitHub Enterprise Server** is out of MVP-1. The owner asked only for self-hosted GitLab to be first-class, and GHES lags github.com's API, for example `merge-async`. The `host` field would carry it in a later effort.
- **Testing.** One contract test suite runs against both adapters on recorded responses.
- Decided on [What forge abstraction keeps GitHub and GitLab equal?](https://github.com/omkarbhale/entail/issues/31).
