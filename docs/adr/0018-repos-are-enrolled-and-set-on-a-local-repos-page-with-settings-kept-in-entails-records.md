# Repos are enrolled and set on a local Repos page, with settings kept in entail's records

The owner enrolls a repo, changes its settings, pauses it and unenrolls it on a **Repos page**. The page is served by entail's local process, beside the board and the Calls page (owner). A repo's settings are stored in entail's local store as versioned records, so they are copied to the records repo and restored with it (ADR-0009). Nothing is written into the project's repo. Every call already records the settings and pins version it used.

The owner chose this over a CLI, a hand-edited config file, or a file committed in the project's repo. A page fits a review the owner confirms once, such as the proposed generic criteria. A config file is something an agent on the same machine edits in passing, and that is how a pin would quietly disappear or an executor would quietly get added, which is "drift nobody chose" in VISION.md's words. A settings page carries the same localhost exposure as the board form and no more. A file in the project's repo would publish private pins on a public repo, any PR could change it, and entail never pushes there.

## Considered options

- **A CLI (`entail repo add`, `entail repo set`)**: rejected by the owner in favour of the page. The settings would have been stored the same way.
- **A hand-edited config file in entail's config directory**: rejected. It is the easiest way for an agent to change a pin or the executor list unnoticed.
- **A file committed in the project's repo, such as `.entail.yml`**: rejected. It is public on a public repo, any PR could change it so it would need a built-in pin, and entail never pushes to the project.
- **Unenroll only, with no pause**: rejected by the owner, who wanted a pause that keeps labels and states, beside unenroll.

## Enrolling

1. **The owner states the forge.** That means `forge` (`github` or `gitlab`), `host` and `path` (ADR-0015).
2. **entail checks the repo and refuses to enroll it when:**
   - the CLI for the host is missing or not logged in;
   - the project cannot be read;
   - the logged-in account cannot add labels and comment;
   - GitLab is older than 15.6;
   - or the default branch has no VISION.md, or an empty one. An empty vision contradicts nothing, so every ticket would be cleared as unopposed: PROBLEM.md's "a tool that accepted an empty vision as done". The page points the owner to /vision.

   It warns, but still enrolls, if the account may lack permission to merge into the default branch. The forge then refuses the merge, and ADR-0014 comments when it does.
3. **entail resolves and sets up:**
   - the numeric project id;
   - the logged-in account, which is "the owner" for that host: its new issues enter on their own, and its `/entail` comments pull in other issues;
   - the fetch-only mirror (ADR-0015).
4. **The owner reviews and confirms one screen, once:**
   - **Generic criteria.** entail proposes them in one read-only model run over the mirror's CI files and build scripts. It is only a suggestion, so it gets no challenge. Each row G1…Gn shows its sentence, its mechanical check (usually "the check `<name>` passes", picked from checks that actually reported on the default branch's recent commits) and the file it was inferred from. Rows can be edited, removed and added. An empty list is allowed, and ADR-0013's merge guard still applies. A criterion naming a check that has not reported on recent default-branch commits gets a warning, because ADR-0015 holds such a check pending forever.
   - **The origin of the existing VISION.md** (ADR-0004). It is preselected as "proposed by an agent and approved by the owner", because VISION.md says a vision is first written with /vision. The owner can change it.
   - **The merge method on GitHub.** GitHub has no repo default, and its API's default fails where merge commits are disallowed. If the repo allows exactly one method, entail uses it. If several are allowed, squash is preselected, or else the first allowed of merge commit and rebase. On GitLab, the project's own merge method and squash default apply, and entail has no setting for them.
   - **The defaults**: shadow off (ADR-0014), "who counts" set to anyone (ADR-0013), and no pins beyond the built-in VISION.md pin.
5. **Issues already open are not taken in.** Only issues the owner opens after enrollment enter on their own, and the owner pulls in any existing issue with `/entail`.

## The settings

| Setting | Set how | Takes effect |
| --- | --- | --- |
| Forge (`forge`, `host`, `path`) | stated at enrollment | fixed; records are keyed on the project id |
| Origin of the existing VISION.md | preselected, confirmed at enrollment | once |
| Generic criteria G1…Gn | proposed by entail, confirmed or edited | for tickets cleared after the save (ADR-0014) |
| Merge method (GitHub only) | inferred, confirmed, editable | from the next merge |
| Shadow | switch, off by default | from the next landing check |
| Who counts, and its executor list | anyone, or the owner plus listed executors; usernames resolved to ids on save (ADR-0015) | from the next landing check or findings comment |
| Pins | topic sentence, optional path globs, optional keywords; the VISION.md pin is built in and cannot be removed | at once, see below |
| Paused | switch | see below |

- **No other per-repo settings in MVP-1.** Whose issues count is fixed: the owner's own new issues, plus any issue the owner pulls in with `/entail`. Listed executors count for PRs and findings only. The poll interval is entail-wide (ADR-0017), not set per repo.
- **Settings versions.** Every save makes a new settings version, recorded with its time and the owner's name and listed in the repo's settings history. A settings save is not a call and not a board answer. It changes how entail decides from then on, never a past call.
- **Shadow and who counts.** These apply from the next landing check. Switching shadow off does not merge a PR that already got a "would merge" comment. A new push or a new evidence section gets it checked again, or the owner merges it by hand. When "who counts" is tightened, entail stops checking PRs from accounts no longer counted, and each such PR gets ADR-0013's one-time comment.
- **Pins.**
  - Adding a pin is handled like a vision change. Cleared and landing tickets are re-checked against it and merge nothing until the re-check is recorded (ADR-0016).
  - The landing check always uses the pins current at check time.
  - Editing a pin counts as removing the old pin and adding the new one.
  - Any pin change withdraws the open board items it touched (ADR-0008), and their tickets are decided again.
- **A vision that disappears.** If an enrolled repo's VISION.md later disappears or becomes empty, entail decides nothing new and lands nothing in that repo. The Repos page says so until a vision is back.
- **CI files changing.** If a repo's CI files change after its generic criteria were confirmed, its settings page shows a passive hint. There is no board item and no notice, because this is setup, not a product decision.

## Pausing and unenrolling

- **Pause** (owner). entail stops polling and writing in the repo, and keeps every label and ticket state.
  - The pause takes effect once the repo's running decider and landing runs finish and their writes are posted. No call is left with its forge write held back. Until then, the Repos page shows the repo as "pausing".
  - The repo's board items stay in the inbox with their answer form locked, saying "this repo is paused", much like a withdrawn item (ADR-0012). No new items or notices come from a paused repo.
  - An executor can keep working from `entail:cleared` during a pause, and its PR is checked on resume.
- **Resume.** Polling restarts from the cursors saved at pause, and GitLab's overlap window applies as usual. Changes made during the pause are handled as if entail had been slow:
  - the owner's new issues are taken in, and `/entail` comments are honoured;
  - issues closed elsewhere cancel their tickets, and PRs merged elsewhere record their tickets as merged;
  - vision and pin changes flag tickets;
  - a PR is landing-checked only at its current head.

  Catch-up runs before the locked items unlock, so an item whose basis changed is withdrawn as usual (ADR-0008). A long pause on GitLab can cost many requests on resume.
- **Unenroll.** It ends the repo's work cleanly:
  1. entail cancels every in-flight ticket with a logged call whose reason is "repo unenrolled".
  2. It removes its `entail:` labels from those issues, so no executor works from criteria nobody will check (ADR-0013: an executor can trust the label alone).
  3. It withdraws the repo's open board items.
  4. It stops reading and writing in the repo.

  It posts no comments and closes no issues. The confirm screen shows how many tickets are in flight first. The records stay, read-only (ADR-0009). Re-enrolling takes in only new issues, like ADR-0009's fresh start. A paused repo can be unenrolled directly.

## Consequences

- **The Repos page** lists each enrolled repo with its forge, its state (active, pausing, paused, or no vision), the time of its last successful poll and a link to its settings. Like the Calls page, it raises no board items, so the board stays limited to product decisions.
- **Global settings.** The owner's display name, the records repo remote, the notice connector, and ADR-0017's poll interval, port and model-run limit are entail-wide settings. They are kept and versioned the same way, on a page of their own. Their content is decided elsewhere.
- **The local server** protects the enrollment and settings forms exactly as it protects the board form: its own `Host` and `Origin` only, and a per-start token on every form (ADR-0017).
- **Enrolling and settings need entail running.** The Repos page is served by the running process, so enrolling, changing settings, pausing and unenrolling happen there and not through separate `entail` commands. This narrows ADR-0017's mention of `entail` commands for enrolling and settings. Those commands are not needed, because the board already requires the process to be running. The running process re-reads settings on every pass (ADR-0017), so a saved change takes effect within one pass.
- **Two kinds of halt.** The owner's pause is a setting. It is not the automatic halt of ADR-0017, which stops a repo's work while its host's CLI is logged out or logged in as another account, or while the subscription's usage limit is reached. The Repos page shows them apart.
- Decided on [How is a repo enrolled, and what per-repo settings exist?](https://github.com/omkarbhale/entail/issues/25).

## Amendment: the global settings and the model

Settled after the MVP-1 spec was assembled, as an engineering call the owner delegated (open point 8 of `docs/spec/mvp-1.md`). [#19](https://github.com/omkarbhale/entail/issues/19) and [#21](https://github.com/omkarbhale/entail/issues/21) set the model "once in entail's global config", but the list above left it out. The global settings live on a page of their own, linked from the Repos page, kept and versioned like repo settings. They are the only entail-wide settings in MVP-1:

| Setting | Default | Takes effect |
| --- | --- | --- |
| Owner's display name | none; asked for before the first enrollment | from the next comment or answer |
| Records repo remote | none ("no remote set" is shown here, ADR-0019) | from the next records push |
| Notice connector | `desktop` (ADR-0017) | from the next notice |
| Model | Opus 5.5 (`claude-opus-5-5`) | from the next model run |
| Model-run limit | 2 | from the next pass |
| Poll interval | 60 s | from the next pass |
| Board port | 7419 | from the next start |

- **The model** is one setting for every model run, because nothing decided a per-run choice. Each call already records the model of every run behind it (ADR-0009).
- **The display name** has no default, because the attribution line and every answer carry it and no forge account name is reliably the name the owner wants. Enrolling waits until it is set.
- **The port** changes only on the next start, because a running server keeps the port its posted links use (ADR-0017).
