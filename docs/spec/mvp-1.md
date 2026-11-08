# MVP-1 spec

This spec puts together, for implementation, the decisions recorded on the [MVP-1 wayfinder map][#12]. It adds no new decisions. Every requirement links to the ticket or ADR it comes from: `[ADR-nnnn]` points to `docs/adr/`, and `[#n]` points to a resolved map ticket. Where a later decision amends an earlier one, the spec follows the later one, and [Further Notes](#further-notes) lists the statements it replaced. Anything missing or contradictory is listed under [Open points](#open-points) and is not decided here.

[VISION.md](../../VISION.md) is the acceptance policy, [PROBLEM.md](../../PROBLEM.md) records the problem, and [GLOSSARY.md](../../GLOSSARY.md) defines the terms. Words in **bold** below are glossary terms and mean only what the glossary says.

## Problem Statement

The owner runs agent-driven work on their own repositories, and every decision comes back to them in chat. Nothing records what a product is or what the owner has said should be in it, so no work can be checked against it. Nothing defines which decisions need the owner, so all of them do. Whatever is said in chat is lost. Filing an issue or mentioning something starts nothing on its own: each piece of work needs the orchestrator to be asked again in chat. ([PROBLEM.md](../../PROBLEM.md))

The owner wants to own the vision while implementation and decisions happen automatically. The bet is that models are already intelligent enough, and what is missing is the engineering to use them. ([PROBLEM.md](../../PROBLEM.md), [VISION.md](../../VISION.md))

## Solution

MVP-1 of entail is one local process that the owner starts once. It: [#12]
- watches the owner's GitHub and GitLab issues;
- decides, against each repo's **vision of record**, whether the owner is needed;
- clears issues that need no product decision and publishes their **criteria** for any **executor** to pick up;
- merges the resulting **PR** once the executor's **evidence** meets those criteria and the repo's **generic criteria**;
- brings every call the vision cannot settle to a local **board** as a structured **board item**;
- cites and logs every **call** it makes on its own.

For the owner it works like this:
1. The owner enrolls a repo that has a VISION.md on a local Repos page. [ADR-0018]
2. From then on, every new issue the owner opens enters intake, and the owner can pull in any other open issue with a `/entail` comment. [ADR-0018], [ADR-0020]
3. entail judges each issue against the vision and the repo's **pins**. [ADR-0011]
   - It clears what the vision **settles**, and what the vision does not contradict, which is **unopposed**. It posts an **intake comment** with a **vision check** and the criteria, and labels the issue `entail:cleared`. [ADR-0007], [ADR-0013]
   - It sends what **needs the owner** to the board and sends a desktop notice. [#12], [ADR-0017]
4. Any executor (firstmate, a Claude Code action, a person) does the work and opens a PR with evidence. [#24], [ADR-0013]
5. entail runs a **landing check** on the PR. A PR that passes merges automatically, pinned to the head entail checked. [ADR-0014]
6. The owner answers board items only on the board, sees every call on a read-only Calls page, and fixes a wrong call through the issue, the vision or a pin. [ADR-0008], [ADR-0009]

entail never executes, never pushes code and never opens PRs. On the forge it only comments, labels, closes and merges. [#24]

## User Stories

Actors: the **owner** (the one person entail serves in MVP-1), an **executor** (whatever does a cleared issue's work), a **reporter** (whoever filed an issue) and an **agent** that edits a vision.

### Enrolling and setting up a repo

1. As the owner, I want to enroll a repo on a local Repos page by stating its forge (`github` or `gitlab`), host and path, so that I need no config file or separate command. [ADR-0018], [ADR-0015]
2. As the owner, I want self-hosted GitLab to work exactly as gitlab.com and GitHub do, so that every repo I have is served the same way. [ADR-0015], [#12]
3. As the owner, I want enrollment refused when the repo's default branch has no VISION.md or an empty one, with a pointer to /vision, so that an empty vision can never clear every ticket. [ADR-0018]
4. As the owner, I want enrollment refused when the host's CLI is missing or logged out, the project cannot be read, my account cannot add labels or comment, or the GitLab instance is older than 15.6, so that entail never starts on a repo it cannot serve. [ADR-0018], [ADR-0015]
5. As the owner, I want a warning, not a refusal, when my account may lack permission to merge, so that I can still enroll and see the forge's refusal later. [ADR-0018]
6. As the owner, I want entail to propose generic criteria G1…Gn from the repo's CI files and build scripts, each with its check and the file it came from, so that I confirm them once instead of writing them. [ADR-0014], [ADR-0018]
7. As the owner, I want to edit, remove or add generic criteria rows, or leave the list empty, and be warned about a check that has not reported on recent default-branch commits, so that the list fits the repo. [ADR-0018]
8. As the owner, I want to choose the origin of the existing VISION.md once, preselected as proposed by an agent and approved by me, so that every existing line has a recorded origin. [ADR-0004], [ADR-0018]
9. As the owner of a GitHub repo, I want to confirm the merge method once, so that merges do not fail where merge commits are not allowed. [ADR-0018]
10. As the owner, I want issues that were already open at enrollment left alone, so that enrolling does not flood intake. I can pull any of them in with `/entail`. [ADR-0018]
11. As the owner, I want a shadow switch per repo, off by default, so that I can watch entail decide and check without it merging. [ADR-0014], [ADR-0018]
12. As the owner, I want to choose per repo whether anyone's PRs and findings count or only mine plus listed executors', so that I can tighten a repo that gains users without a redesign. [ADR-0013], [ADR-0018]
13. As the owner, I want to pin topics, each with optional path globs and keywords, with VISION.md always pinned, so that anything touching them always comes to me. [#19], [ADR-0018]
14. As the owner, I want adding a pin to re-check cleared and landing tickets the way a vision change does, so that a new pin also covers work already in flight. [ADR-0018]
15. As the owner, I want each settings save kept as a version with its time and my name, and each call to record the version it used, so that I can see what any call was judged under. [ADR-0018], [ADR-0009]
16. As the owner, I want to pause a repo, which keeps its labels and ticket states, and resume it with a catch-up, so that I can stop entail on a repo without losing anything. [ADR-0018]
17. As the owner, I want to unenroll a repo, which cancels its tickets in flight, removes its labels and keeps its records read-only, so that no executor keeps working from criteria nobody will check. [ADR-0018]
18. As the owner, I want a renamed or transferred repo to keep its records, so that history follows the project. [ADR-0015]

### Taking issues in

19. As the owner, I want every new issue I open in an enrolled repo taken into intake automatically, so that filing an issue starts work with no chat. [#12], [ADR-0018]
20. As the owner, I want a `/entail` comment from my account, as the whole first line of a new comment, to pull an open issue into intake, so that I can bring in someone else's issue or an older one. [ADR-0020]
21. As the owner, I want nobody else's issue or `/entail` comment to start anything, and nothing posted in reply to them, so that strangers cannot steer entail on a public repo. [ADR-0020], [#12]
22. As the owner, I want a `/entail` on a closed issue answered once, telling me to reopen it and pull it in again, so that I am not left guessing. [ADR-0020]
23. As the owner, I want a `/entail` on a ticket that is already in flight to do nothing and post nothing, because the intake comment already says where it stands. [ADR-0020]
24. As the owner, I want an issue whose ticket has ended to come back only when I pull it in, as a new ticket linked to the one before, so that "final" stays final and the thread is kept. [ADR-0020]
25. As the owner, I want reopening an issue to pull nothing in, whoever reopened it, so that an agent acting under my login cannot silently restart intake. [ADR-0020]
26. As the owner, I want issue text treated as a request to be judged, even when I filed it, so that an agent's words posted under my login never count as mine. [ADR-0001]

### Judging a ticket

27. As the owner, I want a plainly oversized ticket declined, with a logged reason and an issue comment and no board item, because splitting is not in MVP-1. [#19], [#12], [GLOSSARY.md](../../GLOSSARY.md)
28. As the owner, I want any ticket that touches a pin to come to me, with generous matching (the model's judgment, a keyword or a path), so that pinned topics are never decided without me. [#19], [ADR-0011]
29. As the owner, I want a ticket whose every reading contradicts a vision line to come to me with that line cited, so that entail never refuses or cancels a ticket on its own reading of the vision. [ADR-0011], [#21]
30. As the owner, I want a ticket the vision settles cleared with a citation of whole vision lines, quoted word for word at the vision's commit with a permalink, so that I can audit what it relied on. [ADR-0003], [#19]
31. As the owner, I want a ticket the vision does not contradict, that touches no pin and has no consequential readings, cleared as unopposed, with "no contradiction found" recorded and the chosen reading stated in its criteria, so that minor work never waits for me. [ADR-0011]
32. As the owner, I want a ticket whose readings are consequential to come to me with those readings offered as options, so that a product call is never made silently. [ADR-0011], [ADR-0008]
33. As the owner, I want every automatic verdict to pass mechanical checks and an independent challenge before it clears anything, so that clearing never rests on a model's confidence. [ADR-0002], [ADR-0011]
34. As the owner, I want machine failures (no output, an error, a timeout, a refusal, a usage limit) retried and never put on my board, so that the board holds only product decisions. [ADR-0002], [ADR-0017]
35. As the owner, I want an issue whose cause or validity is unknown marked for investigation with numbered questions, so that a wrong or unreproducible report can still end. [ADR-0006]
36. As the owner, I want entail to close a duplicate, already-fixed or unreproducible report, citing its evidence, with the reason logged, so that such issues do not stay open forever. [#21], [ADR-0006]

### Criteria

37. As the owner, I want each cleared ticket to get between one and five criteria, each traced to its source and carrying mechanical checks where possible, so that landing is checked against what was asked. [ADR-0005]
38. As the owner, I want an unopposed ticket fenced off every pin's paths and VISION.md, so that a minor change cannot reach what I pinned. [ADR-0005], [ADR-0011]
39. As the owner, I want a criterion that would fix something users can observe, which its source does not choose, to send the ticket to me, so that writing criteria never makes a product call. [ADR-0005]
40. As the owner, I want criteria frozen in entail's records, with the issue comment only a copy, so that nobody can change them by editing a comment or a PR. [ADR-0005]

### The intake comment

41. As a reporter, executor or owner, I want each decision posted on the issue as a vision check followed by what happens next, so that everyone sees the same reasoning, including which lines did not settle it. [ADR-0007]
42. As the owner, I want every comment entail posts to open with an attribution line such as "Speaking from Omkar's entail:", so that its words never read as mine. [#31], [ADR-0015]
43. As an executor, I want the intake comment to end with one fixed line telling me how to report, so that I need no integration to learn the contract. [ADR-0013]

### Working as an executor

44. As an executor, I want to be able to trust the `entail:cleared` or `entail:investigate` label alone, so that I know when an issue is ready for work. [ADR-0013]
45. As an executor, I want to report evidence per criterion id in an `entail evidence` section, in the PR description or a PR comment of mine, so that a pipeline that rewrites the description cannot erase it. [ADR-0013]
46. As an executor, I want to answer an investigation in one `entail findings` comment, by question id, so that entail can decide the ticket again from it. [ADR-0013], [ADR-0006]
47. As an executor, I want a PR that links an issue with no criteria in force to get one comment saying so, so that I know why it is not checked. [ADR-0013], [ADR-0006]
48. As an executor outside a repo's listed executors, I want one comment saying the repo lands work only from its executors, so that I know my PR will not be checked. [ADR-0013]

### Landing

49. As the owner, I want a landing check to run only once every check at the PR's head has finished, and once per head, evidence section and criteria version, so that nothing is judged early or twice. [ADR-0014], [ADR-0016]
50. As the owner, I want mechanical checks first, then a fresh grader that quotes evidence word for word, then a challenge, so that the one step that does not wait for me is not one model's word. [ADR-0014]
51. As the owner, I want a PR that changes something users can observe beyond its criteria not to merge, so that a cleared issue is never a way to merge features nobody asked for. [ADR-0014]
52. As an executor, I want one landing comment per run that marks each C and G id as met or not met and names the head checked, so that I know exactly what is missing. [ADR-0014]
53. As the owner, I want a passing PR merged through the API pinned to the checked sha, never with an admin override, and a comment when the forge refuses, so that a later push or a protection rule is never bypassed. [ADR-0014], [ADR-0015]
54. As the owner, I want a PR that touches a pinned path brought to me only after everything else in its landing check passes, so that I am never asked about a PR that would fail anyway. [ADR-0014]
55. As the owner of a shadow repo, I want a passing PR to get a "would merge" comment with no board item and no notice, and my own merge recorded, so that I can try entail without it merging. [ADR-0014]
56. As the owner, I want a PR merged by someone else, me included, to record its ticket as merged, so that the records match the forge. [GLOSSARY.md](../../GLOSSARY.md), [ADR-0014]

### The board

57. As the owner, I want the board to be an inbox of open items, oldest first across all repos, beside the selected item, so that nothing waits forever behind newer items. [ADR-0012]
58. As the owner, I want each item to show the decision, why it was raised, the vision check, the issue quoted as the reporter's request, the calls so far and the answer form, in that order, so that I decide with the structure chat lacks. [ADR-0008], [ADR-0012]
59. As the owner, I want to answer by choosing an option, answering in my own words or choosing "don't go ahead", with an optional note that stays private unless I tick "show my note on the issue". [ADR-0008]
60. As the owner, I want to review my answer and the exact issue comment before it is recorded as final, and then see a receipt with a "Next decision" button, so that a final answer on a possibly public issue is never one click. [ADR-0012]
61. As the owner, I want one warning when going ahead goes against a vision line, saying it is an exception for this ticket only, so that I do not think I changed the rule. [ADR-0012]
62. As the owner, I want an item whose basis changed (the issue closed, deleted, moved or edited, or a vision or pin change touching it) withdrawn, with its form locked and my typed text kept to copy, so that I never answer a stale question. [ADR-0008], [ADR-0012], [ADR-0020]
63. As the owner, I want answered and withdrawn items kept under "Answered or withdrawn today" until the end of the day. [ADR-0012]
64. As the owner, I want the board form to be the only way my answer enters entail, recorded under my display name with the time and the item version, so that nobody else's words become mine. [ADR-0008]
65. As the owner, I want a desktop notice and an issue comment linking the board, with no question text, when an item is raised, so that I know an item is waiting without the question moving into a thread. [#12], [ADR-0007], [ADR-0017]
66. As the owner, I want my answer to settle only its own ticket, with "don't go ahead" cancelling it and closing the issue as not planned. [ADR-0008]

### Vision changes and issue edits

67. As an agent editing a VISION.md, I want to record each new line's origin with a `Vision-Origin:` commit trailer, so that my words are never recorded as the owner's. [ADR-0004]
68. As the owner, I want a line that arrives with no trailer recorded as stated by me, so that my own hand edits need no ceremony. [ADR-0004]
69. As the owner, I want a vision change that adds a line, or removes a line a call cites, to re-check in place every cleared or landing ticket that was cleared automatically, with its merge held until the re-check is recorded, so that work never lands against a vision that changed under it. [ADR-0016]
70. As the owner, I want tickets I cleared by my own answer left alone by my vision edits, so that I am not asked again about my own decision. [ADR-0016]
71. As the owner, I want an edit to a cleared or landing issue's title or body to re-check it in place, including one I answered, without reopening my answer, so that a changed request never merges unjudged. [ADR-0020]
72. As the owner, I want a re-check to change the issue only when something an executor reads changed, and otherwise to appear only on the Calls page, so that my vision edits do not spam every issue. [ADR-0016]
73. As the owner, I want entail to re-read VISION.md and the issue's text just before merging, so that a vision change or an edit landing at the last moment is never missed. [ADR-0016], [ADR-0020]

### Records and audit

74. As the owner, I want every call recorded with its reason, citation, checks, challenge, the exact inputs it judged and its full model runs, so that an audit shows what entail actually saw. [ADR-0009]
75. As the owner, I want a read-only Calls page, filterable by repo, ticket, kind, date and vision change, and a history page per ticket, so that I can audit without the board filling up. [ADR-0009], [ADR-0016]
76. As the owner, I want my records copied to a records repo and pushed to a remote I choose, never one entail can verify is public, so that they outlive my machine and my private notes stay private. [ADR-0009]
77. As the owner, I want entail to do nothing in a repo whose issues carry its marker but for which it has no records, until I restore them or confirm a fresh start, so that it never acts without its history. [ADR-0009]
78. As the owner, I want to fix a wrong call by closing the issue, reverting the change, adding a vision line or adding a pin, so that the board answer stays the only way my word enters entail. [ADR-0009]

### Running entail

79. As the owner, I want to run entail in the foreground with `entail run`, or as a per-user service with `entail service install`, so that it keeps running without a chat session. [ADR-0017]
80. As the owner, I want only one copy running per machine, and a restart to lose and repeat nothing, so that issues never get duplicate comments or merges. [ADR-0017]
81. As the owner, I want entail to use my own Claude subscription, at most two model runs at a time, and to pause model work at the usage limit, so that it shares my subscription without its own API key. [#15], [ADR-0017]
82. As the owner, I want entail to act through my own `gh` and `glab` and never hold a token, so that no credential reaches its records. [ADR-0015]
83. As the owner, I want a health strip on every page entail serves while anything is halted or warned, so that I see why decisions stopped arriving where I already look. [ADR-0019]
84. As the owner, I want one desktop notice when a halt begins that I must fix by hand, and none for waits that clear on their own, so that I am interrupted only when I must act. [ADR-0019]
85. As the owner, I want `entail status` to work whether or not entail is running, with exit codes and `--json`, so that my own scripts can check it. [ADR-0019]
86. As the owner on WSL, I want desktop notices to reach my Windows desktop. [ADR-0017]
87. As the owner, I want the local server to refuse requests from other origins and hosts and to require a per-start token on every form, so that no other web page can forge my answer. [ADR-0017], [ADR-0018]

### Acceptance

88. As the owner, I want MVP-1 accepted only when, on fixture repos, it never clears a ticket that should reach me and clears each expected ticket in at least 2 of 3 runs, with every call logged and cited, so that a wrong "already settled" fails the release. [ADR-0010], [#28]

## Implementation Decisions

### 1. Process, stack and data directory

- **One process.** `entail run` is one long-running TypeScript process on Node 24 LTS, one npm package with one `entail` command. One copy runs per machine, and a second `entail run` refuses to start. entail runs on one machine at a time. [ADR-0017]
- **Service.** `entail service install` registers the same command as a systemd user unit on Linux and WSL, or a launchd agent on macOS. It starts at login and restarts after a crash. `entail service uninstall` removes it. [ADR-0017]
- **Stack.** [ADR-0017]
  - The store uses `node:sqlite`.
  - Pages are server-rendered HTML from `node:http`, with a little inline script, no front-end framework and no UI build step.
  - Verdict, criteria and grade schemas are written once in TypeScript and emitted as JSON Schema for `claude -p --json-schema`.
  - Tests use `node:test`.
  - Linux (WSL included) and macOS are supported. Native Windows is out of MVP-1.
- **Data directory.** `$XDG_DATA_HOME/entail` (default `~/.local/share/entail`) on Linux and WSL, and `~/Library/Application Support/entail` on macOS. It holds the store, the records repo, the git mirrors, the operational log, the status file and the lock. [ADR-0017], [ADR-0019]
- **The pass.** Every 60 seconds (an entail-wide setting), for each enrolled repo that is not paused or halted: [ADR-0017]
  1. read what changed on the forge;
  2. for every non-final ticket, work out its next owed step from its records and the latest forge state;
  3. start that step unless it is already running.

  There is no job queue. Owed work is a function of the records, so a restart loses nothing and repeats nothing.
- **Polling and concurrency.** [ADR-0017]
  - Each pass checks the default branch's head with `git ls-remote` and fetches the mirror only when the head moved or a PR head is needed.
  - A landing PR's checks are read on the same pass.
  - At most four forge subprocesses run at once across all repos.
  - A rate limit is honoured until its reset. Any other failure backs off that repo alone, doubling up to 15 minutes.
  - Settings are re-read on every pass, so a saved change takes effect within one pass.
- **Forge writes are intents.** Every comment, label change, close and merge is recorded as an intent before it is sent and confirmed after. On start, before the first pass, unconfirmed intents are settled by reading the forge: a comment is found by its hidden marker, a merge by the PR's state, and labels and closes are applied again. [ADR-0017], [ADR-0015]
- **Model runs.** [ADR-0017], [#19]
  - At most two model runs at once across all repos (an entail-wide setting), and one model step per ticket at a time. A verdict and its challenge, or a grade and its challenge, run one after the other.
  - Waiting runs are ordered: landing checks first, then criteria after an answer, then new intake, oldest first within each group.
  - Each run has a 10-minute timeout, ended with SIGINT, then SIGTERM after a grace period.
  - Machine failures are retried after 1, 2, 4… minutes, capped at 30, with no attempt limit. They are logged to the operational log and never reach the board.
  - A run in flight when entail stops is discarded and run again on the next start.
  - A usage-limit failure pauses all model runs until the reset time `claude` reports, or for 30 minutes if it reports none. Tickets stay deciding or landing.
  - There is no budget. Each run's estimated cost is recorded.
- **Start.** [ADR-0017], [ADR-0019]
  1. Take the lock. A held lock exits.
  2. Open the store. Failing to open it exits.
  3. Check that `git` and `claude` are present and logged in. If either fails, the process stays up, serves its pages with the halt shown, does no forge reads or writes and no model runs, and re-checks on every pass.
  4. For each enrolled host, check that `gh` or `glab` is logged in as the account recorded at enrollment. A failing host halts only its repos.
  5. Run the check for marked issues with no records (section 3).
  6. Settle unconfirmed intents.
  7. Start the board server, which exits if the port is taken, then the passes.
- **Stop (SIGINT or SIGTERM).** Start no new work, interrupt model runs, wait up to 10 seconds for in-flight forge writes to confirm, commit and push the records repo, then release the lock. [ADR-0017]
- **Operational log.** Polls, backoffs, retries, machine failures, usage-limit pauses and failed notices are not calls. They go to a JSON-lines file in the data directory, rotated at 10 MB with five files kept, and to stdout. [ADR-0017], [ADR-0009]

### 2. Forge adapter

- **Two layers.** [ADR-0015]
  - **Repository content** comes from a local, fetch-only git mirror of each enrolled repo: VISION.md and its commit, `Vision-Origin` trailers, CI files, and each PR's diff and changed paths at the checked head (from `refs/pull/<n>/head` or `refs/merge-requests/<iid>/head`). Diffs are computed by git, identically on both forges and never truncated.
  - **The social layer** goes through one `Forge` interface with exactly two adapters, GitHub and GitLab: issues, PRs, comments, labels, closing, merging, checks and identity. Nothing above the adapter names a forge.
- **Transport.** Every adapter call runs as `gh api --hostname <host>` or `glab api --hostname <host>`. entail never holds or stores a token. git authenticates through the same CLI. An in-process HTTP client remains possible later behind this transport seam. [ADR-0015]
- **The forge setting.** `forge` (`github` or `gitlab`, stated, never guessed), `host` and `path`, with no credentials and no base URL. Records are keyed on forge, host and the forge's numeric project id. gitlab.com is the GitLab host `gitlab.com`. [ADR-0015]
- **Identity.** An actor is forge, host and numeric user id, with the username kept for display. Every identity comparison uses the id: the owner's own issues, `/entail` comments, a PR author's evidence, and the executor list. If the CLI later reports a different account than the one recorded at enrollment, or none, entail does nothing in that repo. [ADR-0015]
- **Change detection.** Each adapter answers "what changed since this cursor", and the core deduplicates by kind, id and update time. [ADR-0015]
  - GitHub: ETag-conditional reads of issues and issue comments. `gh api` exits 1 on a 304, so the transport reads the HTTP status.
  - GitLab: re-read issues and merge requests updated within an overlap window of at least two minutes before the cursor, then page each touched one's notes newest first until reaching notes already seen.
  - Cursors are operational state, not records.
- **Checks at a sha.** The adapter reports the checks at one sha and which ones the forge requires. [ADR-0015]
  - GitHub: check runs and commit statuses together. Neutral and skipped count as passed. Required checks come from the default branch's rules.
  - GitLab: the jobs of the pipeline attached to the merge request's current head, whose sha must match. A job with `allow_failure` follows GitLab's pipeline status. The pipeline is required when "pipelines must succeed" is on.
  - A check that a frozen criterion or generic criterion names but that has not reported yet is pending. With no named checks and no checks at all, every check has finished.
- **Writes.** There are exactly four: comment on an issue or PR, add or remove a label, close an issue, and merge a PR pinned to a sha. [ADR-0015]
  - **The comment writer** refuses any body that lacks the attribution line or the hidden marker, or that has a line starting with `/` (so no line is ever a GitLab quick action). [ADR-0015], [#14]
  - A missing `entail:` label is created on first use.
  - GitHub merges through `merge-async` with `sha` and without bypassing rules. GitLab merges through `merge` with `sha` and without `auto_merge`. Any outcome other than merged is a refusal.
  - The adapter supplies "merge request" for GitLab comments.
- **Linked PRs.** A PR is the ticket's PR when the forge's own linked-issue data says it closes the issue: closing issue references on GitHub, and the issues a merge request closes on GitLab. Text is not parsed. [ADR-0013]
- **Self-hosted GitLab.** entail reads `/api/v4/version` at enrollment, refuses versions older than 15.6 and relies on nothing above the Free/CE tier. [ADR-0015], [#31]
- **GitHub Enterprise Server** is out of MVP-1. [ADR-0015]

### 3. Store and records

- **One store.** One local SQLite database in the data directory holds every enrolled repo's records: tickets and their state, calls, answers with their notes, vision line origins, vision changes, settings versions and the comments entail posted. The store is the authority. Labels and comments on the forge are copies of it, and nothing goes into a project's repo. [ADR-0009], [ADR-0018]
- **Append-only.** The store refuses updates and deletes. A ticket's current state is the one row that changes, and only in the same transaction as the call that changes it. [ADR-0009]
- **What a call records.** [ADR-0009]
  - its ticket, repo, time, kind and reason;
  - its citation, the answer it cites, or "no contradiction found" for an unopposed clear [ADR-0011];
  - the results of its mechanical checks and its challenge;
  - the inputs it judged: the issue's title and body exactly as read, the vision sha, the pins and settings version, and the PR head sha for a landing check;
  - for every model run behind it, the full input and output, model, prompt version, session id, duration and estimated cost;
  - the forge comment it posted, by id and URL.
- **Calls include** at least verdicts, investigation, criteria writing, declining, closing at intake, landing results, merging, cancelling on an outside close, re-checks, shadow "would merge" results and unenroll cancellations. [#18], [ADR-0006], [ADR-0014], [ADR-0016], [ADR-0018]
- **A board answer is not a call.** The change it causes is a call that cites the answer. [ADR-0008]
- **Ticket links.** A ticket pulled in again links to its predecessor. [ADR-0020]
- **Hidden marker.** Every comment entail posts carries a hidden marker with the ticket's record id, placed so that no line starts with `/`. [ADR-0009]
- **Records repo.** entail commits a text export of the store to a git repository in the data directory after every answer, at least hourly and on stop, and pushes it to a remote the owner sets (entail-wide). [ADR-0009], [ADR-0017]
  - It refuses a remote it can verify is public and says so when the remote is set. A remote it cannot check is accepted. A remote on the same machine gets a note that it does not survive losing the machine.
  - Without a remote, commits stay local. entail shows when its last push succeeded.
  - Restoring means cloning the records repo and importing it into a fresh store.
- **Starting without records.** If entail has no records for a repo whose issues carry its marker, it does nothing in that repo and says so until the owner restores the records repo or confirms a fresh start. A fresh start leaves every marked issue alone and takes in only new ones. [ADR-0009]
- **Unenrolled repos** keep their records, read-only. Nothing is pruned in MVP-1. [ADR-0009]

### 4. Vision of record

- **Source.** The vision of record is VISION.md on the default branch, read from the mirror. Nothing proposed elsewhere counts until it lands there. [GLOSSARY.md](../../GLOSSARY.md), [ADR-0015]
- **Vision lines.** A line is identified by its exact text, compared after collapsing whitespace, with no id and no marks in the file. Moving a line or renaming its heading keeps its identity. Any change of words makes a new line. [ADR-0003]
- **Citations.** A citation quotes one or more whole lines word for word. For each line it stores the commit sha, the heading above it, its exact text and its line number, which is used only for a permalink at that sha. [ADR-0003], [#19]
- **Origins.** [ADR-0004]
  - Origins live in entail's records, never in the repo.
  - For each line a vision change adds, entail reads the `Vision-Origin:` trailer of the commit that added it. The values are `owner-stated`, `agent-proposed-owner-approved` and `automatic-owner-notified`, and a trailer applies to every line its commit adds.
  - A missing trailer, or an unknown value, records the line as stated by the owner, and keeps the raw trailer.
  - At enrollment, the existing VISION.md is recorded under the one origin the owner picks.
- **Vision change.** A new VISION.md blob on the default branch is a vision change, recorded as the lines it removed and added. A reworded line is one removed and one added. [ADR-0003], [ADR-0016]
- **VISION.md is pinned in every repo.** [ADR-0011], [ADR-0018]
- **A vanished vision.** If an enrolled repo's VISION.md disappears or becomes empty, entail decides nothing new and lands nothing in that repo until a vision is back. This is a repo halt. [ADR-0018], [ADR-0019]

### 5. Intake

- **What enters on its own.** A new issue opened by the owner's account (by numeric id) after enrollment. An issue transferred into an enrolled repo is not a new issue. [ADR-0018], [ADR-0020]
- **Pulling in.** A `/entail` counts when a newly posted comment by the owner's account has `/entail` as its whole first line. Text after that line is ignored. Editing an old comment to add it does not count, and each comment counts once, by its forge id. [ADR-0020]
  - On an open issue with no ticket, or whose last ticket is final (and the comment was posted after that final call): the issue is taken in as a new ticket. [ADR-0020]
  - On a ticket in flight: nothing happens and nothing is posted. [ADR-0020]
  - On a closed issue: nothing happens, and entail replies once that it takes in only open issues. [ADR-0020]
  - From anyone else: nothing happens and nothing is posted. [ADR-0020]
- **One ticket in flight per issue.** A ticket pulled in again is taken in fresh (size, verdict and criteria at the current text and vision), linked to its predecessor, and its first intake comment names the predecessor's last one. [ADR-0020]
- **Reopening** pulls nothing in, whoever reopened. [ADR-0020]
- **Issue text is a request.** Title, body and comments at intake are untrusted request text, each tagged with its author, and never the owner's word, whoever filed it. [ADR-0001], [#19]

### 6. The decider

- **Order of judgment.** [ADR-0011], [#19]
  1. **Size.** Decline only when the ticket is plainly oversized (several independent deliverables, or not reviewable as one PR). When unsure, it fits. A declined ticket gets no verdict.
  2. **Pins.** A touched pin needs the owner. A pin counts as touched if the model judges its topic touched, or a keyword or path matches. When unsure, it counts as touched.
  3. **Contradiction.** If every reading contradicts a vision line, the ticket needs the owner, with the line cited. A reading that would contradict a line is not a defensible reading.
  4. **Readings.** If cited lines choose one reading, the verdict is **settled**. If the readings are consequential, the ticket needs the owner. Otherwise the verdict is **unopposed**, with the more conventional reading chosen.
- **Investigating.** After the size check, the decider may choose investigation in place of a verdict when the cause or validity of the issue is unknown, naming numbered questions Q1…Qn (section 8). [ADR-0006]
- **Verdict shape** (one schema-checked object, kept whole on the call). [#19], [ADR-0011], [ADR-0007]
  - `size` (`fits` or `oversized`, with a reason);
  - `readings`, each with the outcome a user would observe;
  - `pins_touched`, each with why;
  - the vision check: each bearing line with its mark (matches, contradicts, does not settle);
  - `verdict`;
  - for settled, `citations`, each with the reading it chooses;
  - for unopposed, `why_unopposed` and `reading_chosen`;
  - for needs the owner, `why_raised` (contradiction, consequential readings, pin or failed check) and the open readings, which become the board item's options;
  - `reason` for the audit log.

  entail adds the model, session id, vision sha, duration, cost and usage.
- **Mechanical checks on a settled or unopposed verdict.** [ADR-0002], [ADR-0011], [ADR-0007]
  - every citation and every quoted vision-check line appears word for word in VISION.md at the recorded sha;
  - settled has a citation, and each settled citation is marked "matches";
  - with several readings, a cited passage chooses one;
  - no line is marked "contradicts";
  - no pin is touched, by the model's judgment or by a keyword or path match.
- **The challenge.** A fresh model session, given the ticket, vision, pins and proposed verdict, tries to overturn it by finding a contradicted vision line, a touched pin, a consequential reading the decider missed, or an uncited assumption behind a citation. It runs only on settled and unopposed verdicts, and once over the verdict and the criteria together. [ADR-0002], [ADR-0011], [ADR-0005]
- **Failures.** A failed mechanical check or a successful challenge makes the ticket need the owner, with the failure as `why_raised`. A citation that fails the word-for-word check is a product failure. Machine failures (no structured output, an error, a timeout, a refusal, a usage limit) leave the ticket deciding, retried. [ADR-0002]
- **Several passages.** A settled verdict may cite several passages, which together must choose one reading. If cited passages point to different readings, the vision does not settle the ticket, and the board item quotes both. [#19]
- **How a model run is made.** [#19], [#21], [#15]
  - `claude -p --output-format json --json-schema <schema>` as a subprocess, on the owner's subscription. A missing `structured_output` is a machine failure.
  - It reads a read-only checkout of the default branch at a recorded sha, with `--tools "Read,Grep,Glob"`.
  - Isolation: `--setting-sources ""`, `--strict-mcp-config` with no servers, `--permission-mode dontAsk` and `--no-session-persistence`.
  - Opus 5.5 for the decider, the challenge and the criteria run, set once in entail's global config.
  - Instructions injected in a third-party issue cannot clear a ticket: the run can only read and return a verdict, and the verdict must still pass the checks and the challenge.
- **Closing at intake.** entail may close an issue at intake, with no verdict and no criteria, only when the repo's state settles that nothing is to be done, such as a duplicate or a report the default branch already fixes. The close cites its evidence, passes mechanical checks that the evidence exists and the same challenge, and is a logged call. entail comments the reason, closes the issue and the ticket is cancelled. A touched pin still goes to the owner, and closing on the vision alone is never allowed. [#21], [ADR-0006]

### 7. Criteria

- **Writing.** A separate read-only `claude -p --json-schema` run writes the criteria, after a settled or unopposed verdict passes its mechanical checks, or after a board answer lets the ticket go ahead. Its input is the issue, the verdict or answer, the vision, the pins and the generic criteria. Its output is the criteria, or "needs a product call" with the reason. [ADR-0005], [#21]
- **Form.** One to five numbered outcomes, C1…Cn. Each is one sentence: what is true once the issue is resolved, or a vision constraint the change must respect (which may restate a vision line). Each is traced to its source: the issue, a vision line or the owner's answer. Criteria never prescribe implementation and never restate generic criteria. [ADR-0005], [#21], [GLOSSARY.md](../../GLOSSARY.md)
- **Mechanical checks** come from a closed list that grows only by a recorded decision: [ADR-0005], [#21]
  - **changes path**: the diff changes a file matching a glob;
  - **leaves path**: the diff changes no file matching a glob;
  - **check passes**: a named check is green at the PR's head.
- **Checks before clearing.** [ADR-0005], [#21], [ADR-0011]
  - one to five criteria;
  - each source exists;
  - each mechanical check is a known kind with valid arguments (the glob parses, and a named check has been seen on the default branch);
  - an unopposed ticket carries leaves-path fences for every pin's paths and for VISION.md;
  - where entail chose between readings, a criterion states the reading chosen;
  - no line starts with `/`.

  Invalid output is a machine failure. The challenge then runs over the verdict and the criteria together, and for criteria looks for one that decides something its source does not.
- **Product calls.** A criterion that would fix something users can observe (behavior, wording, appearance, a default) that its source does not choose sends the ticket to the board with `why_raised` "writing the criteria needs a product call", and the open choice becomes the options. There is no owner sign-off on any path. [ADR-0005], [#21]
- **Freezing.** Criteria are frozen in entail's record once published. Edits to the issue comment, PR text and executors cannot change them. A change is a new criteria version written by a new call, and the landing check uses the latest version. [ADR-0005], [#21]

### 8. Investigation

- When the cause or validity of an issue is unknown, entail adds `entail:investigate` and posts an intake comment whose second section lists the questions Q1…Qn the investigation must establish. Choosing investigation is a logged call with mechanical checks only (at least one question, no line starting with `/`) and no challenge. [ADR-0006], [ADR-0013]
- Any executor reports one `entail findings` comment on the issue, with one entry per question id. entail decides the ticket again on the first findings comment posted after the investigate comment, whoever posted it (subject to "who counts"). Later findings comments are ignored. [ADR-0013]
- Deciding again from the findings: [ADR-0006]
  - a real problem whose fix is now known gets criteria and is cleared;
  - nothing to fix (unreproducible, invalid or already fixed) means entail closes the issue, citing the findings, after the same checks and challenge as any close at intake, and the ticket is cancelled;
  - anything the vision cannot settle goes to the board.
- A ticket is investigated at most once. A question with no entry stays unknown, and findings that leave the problem unknown make the ticket need the owner. [ADR-0006], [ADR-0013]
- Findings are issue text: judged, never the owner's word. [ADR-0006], [ADR-0001]
- A PR linking an issue under investigation is not checked or merged, and entail comments that the issue has no criteria yet. [ADR-0006]

### 9. Comments entail posts

- **Comment rules**, enforced by the one comment writer: the attribution line first, naming the owner in the possessive and reading correctly for any name (for example "Speaking from Omkar's entail:"), the hidden marker, and no line starting with `/`. [#31], [ADR-0015], [ADR-0009]
- **The intake comment.** One comment on the issue each time entail decides the ticket, in two sections. [ADR-0007]
  1. **Vision check.** Each vision line that bears on the issue, quoted whole and word for word in a quote block, with a permalink at the vision's commit, marked as matches, contradicts or does not settle. Only bearing lines are listed, and the comment says so. If none bears, it says that.
  2. **What happens next.**
     - Going ahead: the criteria C1…Cn with their mechanical checks, the generic criteria in full, why the ticket was cleared (a citation permalink, or "no contradiction found"), then the label `entail:cleared`. [ADR-0007], [ADR-0014], [#21], [ADR-0011]
     - Investigating: the questions Q1…Qn, then the label `entail:investigate`. [ADR-0006], [ADR-0013]
     - To the board: that the ticket was raised to the owner, with a link to the board, and no question text. [ADR-0007]

     The section ends with one fixed line telling any executor how to report evidence or findings. [ADR-0013]
- **After an answer**, the intake comment quotes the decision, attributed to the owner: the chosen option, or the owner's own words. The note appears only if the owner ticked "show my note on the issue". [ADR-0008]
- **Each new decision** posts a new intake comment in the same shape, naming the one it replaces, except after a re-check that changes nothing an executor reads (section 12). [ADR-0007], [ADR-0016]
- **Declined and closed tickets.** A declined ticket's comment gives the reason, with no vision check. A close at intake gives its evidence. [ADR-0007]
- **Other comments:** the landing comment (section 11), the one-time comment on a PR with no criteria in force, the one-time comment for an executor who does not count, the merge-refusal comment, the "already merged" comment, the "raised to the owner after a vision change" comment and its follow-up on "don't go ahead", and the one reply to `/entail` on a closed issue. [ADR-0013], [ADR-0014], [ADR-0016], [ADR-0020]

### 10. Executor contract

- entail and an executor meet only on the issue and the PR, the same way on both forges. Nothing is specific to firstmate. [ADR-0013]
- **Labels.** An issue carries at most one `entail:` label, matching the ticket's state: `entail:cleared` while cleared or landing, `entail:investigate` while investigating. entail removes it when the ticket leaves that state. entail ignores anyone else adding or removing its labels. [ADR-0013]
- **Linking.** The PR closes the issue with the forge's closing keyword. A PR that only mentions the issue is not the ticket's PR. A PR into a branch other than the default is not the ticket's PR. [ADR-0013], [ADR-0014]
- **Evidence.** An `entail evidence` section, one entry per id (`C1: <what was run or done> — <result>`, and the same for G ids), in the PR description or in a PR comment by the PR's author. The latest section at the checked head counts. A criterion with no entry is not met. [ADR-0013]
- **Who counts** (per repo): **anyone** by default, or **owner plus listed executors**. Under the latter, entail does not check another account's PR or findings and comments once that it lands work only from the repo's executors. [ADR-0013], [ADR-0018]
- **No pickup signal.** entail neither asks for nor reads a sign that an executor has taken an issue, and ignores assignment. [ADR-0013]
- **Trust.** Claims in evidence and findings are taken as honest, and entail never redoes an executor's validation. [ADR-0013], [#24]

### 11. Landing check and merge

- **When it runs.** Only when the PR is open and not a draft, its base is the default branch, it links a ticket with criteria in force, and every check at its head has finished. It runs once for each distinct head sha, latest evidence section and criteria version. It never comments while checks are pending or on a draft. [ADR-0014], [ADR-0016]
- **Order.** [ADR-0014]
  1. The forge's state (the merge guard below) and every criterion's mechanical checks. A failure ends the run before any model is used.
  2. A fresh read-only grader. It reads the frozen criteria and generic criteria, the evidence, the diff and the check results. For each id it returns met or not met with the evidence quoted word for word, and it lists anything users can observe that the change does beyond the criteria and their stated reading.
  3. Mechanical checks on the grade: every quote appears word for word in the PR at the checked head, and every id has a result.
  4. A challenge, a second fresh run, which tries to show that a criterion marked met is not met, or that the change goes beyond its criteria.

  PR text is untrusted input to both runs. A PR that changes something users can observe beyond its criteria does not pass, and raises no board item. [ADR-0014], [#22]
- **Machine failures** in the grader or challenge are retried and never reported as a failed landing. [ADR-0014]
- **The merge guard**, read live at a pinned head before merging: the PR is open, not a draft, mergeable and conflict-free; every check is green at that head; every check the forge requires has reported. Just before merging, entail also re-reads VISION.md's blob and the issue's title and body. If either changed, it processes that change first and merges only if the ticket was not flagged by it. [ADR-0013], [ADR-0016], [ADR-0020]
- **The landing comment.** One attributed comment on the PR per run, never on the issue. It marks each C and G id met or not met (mechanical results as computed, quoted evidence for each "met", a reason for each "not met"), lists anything beyond the criteria, and names the head sha. A failing comment says the PR will not be merged at that head, and that a new push or evidence section gets it checked again. A passing one ends "merging at `<sha>`". [ADR-0014]
- **A failed landing** leaves the ticket landing. Routing further is a later effort. [ADR-0014]
- **The merge.** Through the API pinned to the checked sha, with the repo's merge method (GitHub: the method set at enrollment; GitLab: the project's own). Never an admin override and never the forge's auto-merge. If the forge refuses, the ticket stays landing and the PR gets one comment saying why. If the forge does not close the issue on merge, entail closes it as part of the merged call and removes `entail:cleared`. [ADR-0014], [ADR-0018], [ADR-0015]
- **A pinned path touched at landing.** An unopposed ticket's fences already fail such a PR mechanically. For any other cleared ticket, unless the owner's answer on this ticket already covered that pin, a diff touching a pinned path raises a board item only after everything else passed. The PR stays unmerged. The item names the pinned paths and takes one of three answers: [ADR-0014]
  - "Merge this PR as it is": entail verifies the same head again and merges;
  - the owner's own words: a new criteria version with that fence, and the ticket returns to cleared;
  - "Don't go ahead": the ticket is cancelled and the issue closed.

  A new push withdraws the item, and the landing check runs again.
- **Shadow.** A passing PR gets the landing comment ending "would merge at `<sha>`; this repo is in shadow, so the merge is left to the owner", recorded as a call. There is no merge, no board item and no notice. Switching shadow off does not merge a PR that already got that comment. [ADR-0014], [ADR-0018]
- **Merges by others.** A PR merged by the owner or anyone else records its ticket as merged, including a PR that failed. [ADR-0014], [GLOSSARY.md](../../GLOSSARY.md)
- **Several PRs for one ticket.** Each is checked on its own against the same frozen criteria, and the first to pass merges. entail then comments once on each other open PR that the ticket is already merged, stops checking them and does not close them. [ADR-0014]
- **One PR linking several tickets** merges only when it passes the criteria of every ticket it links. If any linked issue has no criteria in force, it does not merge, and the landing comment says so. [ADR-0014]
- **A PR closed without merging** returns the ticket to cleared if no other PR for it is open. [ADR-0014]

### 12. Flags and re-checks

- **What flags a ticket.** [ADR-0016], [ADR-0020], [ADR-0018]
  - A vision change flags a cleared or landing ticket whose clear came from an automatic verdict (settled or unopposed) when any line was added, or a line its call cites was removed. A ticket cleared by the owner's answer is not flagged by a vision change.
  - An **issue edit** (a title or body change compared with the text the latest call recorded, ignoring whitespace-only changes and task-list ticks; comments, labels, assignees and milestones are not edits; who edited does not matter) flags any cleared or landing ticket, including one cleared by the owner's answer.
  - Adding a pin flags cleared and landing tickets the same way. Editing a pin counts as removing the old one and adding the new.
- **While flagged** the ticket keeps its state and `entail:cleared`, and nothing for it merges until the re-check call is recorded. No comment is posted for the hold. [ADR-0016]
- **The re-check.** One read-only decider run at the current vision and issue text, given the prior call (citation, vision check, reading chosen) and what changed (lines removed and added, or the old and new text). It answers only whether the change alters the call. Another change before it is recorded restarts it with every change so far. [ADR-0016], [ADR-0020]
- **Outcomes.** [ADR-0016]
  1. **Stands.** The call carries the new citation if the cited line was reworded. The criteria version is kept when every source still exists and the reading is the same, and is otherwise rewritten by the criteria run.
  2. **Goes ahead differently.** A new reading is settled, or the ticket is now unopposed. A new criteria version is written, and the ticket stays cleared or landing.
  3. **Needs the owner.** The ticket goes on the board, `entail:cleared` is removed, and no PR for it merges. Each open PR gets one comment saying the issue was raised to the owner. On "go ahead", a new criteria version is written and the PR is checked again. On "don't go ahead", the ticket is cancelled and the PR gets one comment but is not closed.

  Outcomes 1 and 2 pass the same mechanical checks and challenge as any automatic verdict, and a failure makes the outcome 3. entail never cancels or closes a flagged ticket on its own.
- **A ticket cleared by the owner's answer** keeps that answer through an issue-edit re-check. The re-check can only find a product call the answer does not cover, which goes to the board as a new item for that call alone. Otherwise the ticket stands, or gets a new criteria version that still cites the answer. [ADR-0020]
- **What the issue and the PR see.** A new intake comment, naming the one it replaces and the vision change's sha, only when the vision check's bearing lines or marks, the citation, the criteria version or the state changed. A new criteria version triggers a fresh landing check. A landing check in progress when a flag lands finishes but posts and merges nothing until the re-check is recorded, and its result is reused if the criteria version is unchanged. [ADR-0016], [ADR-0020]
- **Other states.** [ADR-0016], [ADR-0020], [ADR-0008]
  - Deciding: the run in flight is discarded and the ticket decided at the latest vision and text.
  - Investigating: decided at whatever vision and text are current when findings arrive.
  - On the board: the open item is withdrawn and the ticket decided again.
  - Final: nothing happens.

### 13. The board

- **One answer path.** The owner answers only through the answer form on the local board page. No forge comment, chat or command line is an answer. The answerer is recorded as the owner's display name from settings, with the time and the item version answered. [ADR-0008]
- **A board item** is a snapshot taken when it is raised, with live links. Its parts, in order: [ADR-0008], [ADR-0012]
  1. the decision, one sentence, as the heading;
  2. why it was raised, in plain words, with the touched pin by name, the failed check or the challenge's objection;
  3. the vision check, quoting only bearing lines at the vision's commit;
  4. what the ticket was: the issue's title and link, who filed it, and its text quoted as the reporter's request;
  5. what happened: the calls so far, newest first, with a link to the ticket's history (for a ticket pulled in again, including the predecessor's calls and any answer [ADR-0020]);
  6. the answer form.
- **At most one open item per ticket.** [GLOSSARY.md](../../GLOSSARY.md)
- **Answer shapes.** Choose an option (each open reading with the outcome a user would observe, or "go ahead as read" when there is one), answer in my own words, or don't go ahead. Any of them may carry a note, behind "Add a note", with a "Show my note on the issue" tick. "Later", "pause", "reorder" and "split" are not offered. [ADR-0008], [ADR-0012]
- **After an answer.** [ADR-0008]
  - Going ahead returns the ticket to deciding only to write criteria. The verdict is not run again. The answer is a source the criteria cite, and the usual checks and challenge run. A product call the answer does not cover raises a new item for that call alone.
  - "Don't go ahead" cancels the ticket, and entail comments and closes the issue (as not planned on GitHub).
  - An item raised for a pin, once answered, counts as the owner having seen that pin for the ticket.
  - Answers are final. To stop a ticket after going ahead, the owner closes the issue.
- **The page.** [ADR-0012]
  - **Header:** the board, the number of open items, a link to the Calls page, and "answering as" the owner's display name.
  - **List:** open items under "Needs you", oldest raised first across all repos, each with the decision sentence, repo and forge, how long ago it was raised, and a tag for why (contradicts a line, consequential readings, a pin by name, or a failed check). Display order only, with no reordering or postponing. Answered and withdrawn items move to "Answered or withdrawn today" and leave at the end of the day.
  - **Form:** the options, then "Answer in my own words", then "Don't go ahead". When going ahead goes against a vision line, the option carries one warning: "This goes against a vision line for this ticket only. The line stays as it is; to change the rule, edit VISION.md." There is no link to edit the vision.
- **Answering.** "Review answer" records nothing. It shows the answer, whether the note is private or shown, what happens next and the exact comment entail will post. "Record answer as <owner> (final)" records it, and "Back" returns. A receipt then stays in place with who answered, when, the item version, the ticket's new state, what happens next and the comment, plus a "Next decision" button that opens the oldest open item. The page does not move on by itself. [ADR-0012]
- **Withdrawn items.** An open item is withdrawn when its basis changes: the issue is closed, deleted, transferred or converted elsewhere (the ticket is cancelled); the issue is edited; a vision change removes or rewords a line in the item's vision check, or adds a line; a pin change touches it; or, for a landing pin item, a new push arrives (in those cases the ticket is decided or checked again). [ADR-0008], [ADR-0020], [ADR-0018], [ADR-0014]
- **Live updates.** The page asks the local process for the board every few seconds. A withdrawn item's form locks and says why and what happens next. Typed text stays visible to copy and is never recorded. The form submits the item version it showed, and entail refuses an answer to a withdrawn item, an already answered item or an older version. [ADR-0012]
- **Locked items.** A paused repo's items stay listed with the form locked, "this repo is paused". During a host halt that host's items lock with "entail cannot reach <host>". In both cases catch-up runs before the forms unlock. [ADR-0018], [ADR-0019]
- **Notice when an item is raised.** A desktop notice on the machine running entail, plus the intake comment linking to the board, with no question text and taking no answer. Notice delivery is a pluggable connector, and other channels are later connectors. [#12], [ADR-0007], [ADR-0017]
  - Linux: `notify-send`. macOS: `osascript`. WSL (detected from the kernel release): a Windows toast through `powershell.exe`.
  - A failed notice is logged and blocks nothing.

### 14. Calls page and ticket pages

- The **Calls page** is read-only, served by the same process but separate from board items. It lists every call newest first, filterable by repo, ticket, kind and date, and can filter to one vision change and to shadow "would merge" calls. Each call shows its reason, citation permalinks, check and challenge results, links to the issue and PR, and its model input and output one click away. [ADR-0009], [ADR-0016], [ADR-0014]
- Each **ticket page** shows the ticket's whole history, including answers under the name of whoever gave them, and its own retry state. [ADR-0009], [ADR-0019]
- Neither page asks anything or offers any action. [ADR-0009]

### 15. Repos page, enrollment and settings

- **Enrolling, settings, pausing and unenrolling** happen on a **Repos page** served by the running process, not through separate `entail` commands. [ADR-0018]
- **Enrolling.** [ADR-0018], [ADR-0015]
  1. The owner states `forge`, `host` and `path`.
  2. entail refuses when the host's CLI is missing or not logged in, the project cannot be read, the logged-in account cannot add labels and comment, GitLab is older than 15.6, or the default branch has no VISION.md or an empty one (the page points to /vision). It warns, but enrolls, if the account may lack permission to merge.
  3. entail resolves the numeric project id and the logged-in account, which is "the owner" for that host, and sets up the mirror.
  4. The owner confirms one review screen:
     - **Generic criteria** proposed by one read-only model run over the mirror's CI files and build scripts, with no challenge. Each row G1…Gn shows its sentence, its mechanical check (usually "the check `<name>` passes", picked from checks that reported on recent default-branch commits) and the file it was inferred from. Rows can be edited, removed and added, and the list may be empty. A criterion naming a check that has not reported on recent default-branch commits gets a warning.
     - **The origin of the existing VISION.md**, preselected as proposed by an agent and approved by the owner.
     - **On GitHub, the merge method**: the one allowed method, or squash if several are allowed, else the first allowed of merge commit and rebase. GitLab has no such setting.
     - **The defaults**: shadow off, who counts set to anyone, and no pins beyond VISION.md.
  5. Issues already open are not taken in.
- **Per-repo settings.** These are the only ones in MVP-1. [ADR-0018]

  | Setting | Set how | Takes effect |
  | --- | --- | --- |
  | Forge (`forge`, `host`, `path`) | stated at enrollment | fixed; records keyed on the project id |
  | Origin of the existing VISION.md | preselected, confirmed at enrollment | once |
  | Generic criteria G1…Gn | proposed, confirmed or edited | for tickets cleared after the save |
  | Merge method (GitHub only) | inferred, confirmed, editable | from the next merge |
  | Shadow | switch, off by default | from the next landing check |
  | Who counts, and its executor list | anyone, or owner plus listed executors; usernames resolved to ids on save | from the next landing check or findings comment |
  | Pins | topic sentence, optional path globs, optional keywords; the VISION.md pin is built in and cannot be removed | at once |
  | Paused | switch | see below |

- **Settings versions.** Every save makes a new version, recorded with its time and the owner's name and listed in the repo's settings history. A save is not a call and not a board answer, and never changes a past call. [ADR-0018]
- **Generic criteria are frozen** with each ticket when it is cleared. The landing call records the version used. The merge guard applies whatever the generic criteria are. [ADR-0014]
- **Tightening who counts** stops checks on PRs from accounts no longer counted, and each such PR gets the one-time comment. [ADR-0018]
- **Pins.** Adding a pin re-checks cleared and landing tickets (section 12). The landing check always uses the pins current at check time. Any pin change withdraws the open board items it touched, and their tickets are decided again. [ADR-0018]
- **CI files changing** after generic criteria were confirmed shows a passive hint on the settings page, with no board item and no notice. [ADR-0018]
- **Pause.** entail stops polling and writing in the repo once the repo's running decider and landing runs finish and their writes are posted, showing "pausing" until then. Labels and ticket states are kept. An executor may keep working, and its PR is checked on resume. [ADR-0018]
- **Resume.** Polling restarts from the saved cursors. Changes made during the pause are handled as if entail had been slow: the owner's new issues are taken in, `/entail` comments honoured, outside closes cancel, outside merges record merged, vision and pin changes flag, and a PR is landing-checked only at its current head. Catch-up runs before locked items unlock. [ADR-0018]
- **Unenroll.** Cancel every in-flight ticket with a logged call, reason "repo unenrolled"; remove `entail:` labels from those issues; withdraw the repo's open board items; stop reading and writing. No comments and no closes. The confirm screen first shows how many tickets are in flight. Records stay read-only. Re-enrolling takes in only new issues. A paused repo can be unenrolled directly. [ADR-0018]
- **The Repos page** lists each repo with its forge, its state (active, pausing, paused or no vision), its last successful poll and a link to its settings, and shows halts and the owner's pause apart. It raises no board items. [ADR-0018], [ADR-0019]
- **Global settings** (on a page of their own, kept and versioned the same way): the owner's display name, the records repo remote, the notice connector, the poll interval (60 s), the board port (7419) and the model-run limit (2). [ADR-0018], [ADR-0017]
- **The local server** listens on 127.0.0.1 only and refuses to start if its port is taken. It refuses any request whose `Host` is not its own, refuses any write whose `Origin` is not its own, and requires a per-start token on every form: board, enrollment and settings. There is no login. [ADR-0017], [ADR-0018]

### 16. Health

- **Halts.** [ADR-0019], [ADR-0018]

  | Halt | Scope | Clears when |
  | --- | --- | --- |
  | `git` or `claude` missing or logged out | all of entail | the check passes on a pass |
  | Subscription usage limit | all model work | the reset time `claude` reports, or 30 minutes |
  | `gh` or `glab` logged out, or logged in as another account | one host's repos | the check passes on a pass |
  | Host not answering for an hour | one host's repos | a poll succeeds |
  | Marked issues with no records | one repo | the owner restores the records or confirms a fresh start |
  | VISION.md gone or empty | one repo | a vision is back |

  An authentication failure from `claude` while running is the all-of-entail halt. One from `gh` or `glab`, or a wrong account, is that host's halt, not a backoff.
- **Warnings.** [ADR-0019]
  - no records push succeeding for 24 hours while a remote is set;
  - a ticket's model step failing for an hour in a row, or every model run failing for 15 minutes (a count and the last error, never which tickets wait);
  - the last desktop notice failed;
  - a repo failing to poll for 15 minutes or more (at an hour it becomes the host halt);
  - an unexpected stop (a lock left by a dead process), warned until the end of the day.

  "No remote set" is a standing line on the global settings page and in `entail status`, never on the strip.
- **The strip.** While anything is halted or warned, a strip at the top of every page entail serves shows one line each: what is wrong, what it stops, since when and what clears it. Otherwise the header says only when the last pass ran. The strip is not a board item and takes no answer. [ADR-0019]
- **Health notices.** One desktop notice through the board-item notice connector, once when a halt begins that the owner must fix by hand: `git` or `claude` missing or logged out; a host's CLI logged out or on another account; a host not answering for an hour; a repo waiting for records; a vanished vision; no records push for 24 hours while a remote is set; and three unexpected stops within 10 minutes ("entail keeps stopping"). It names the condition and links to the Repos page. Nothing is sent when it clears, and waits that clear on their own never notify. [ADR-0019]
- **`entail status`** reads a status file the running process rewrites on every pass, so it works whether or not entail is running. It prints whether entail is running (pid and start time, from the lock), the last pass, every halt and warning with its onset, each repo's state and last successful poll, the last records push, and recent warning lines from the operational log. It lists no tickets. Exit codes: 0 healthy, 1 halted or warned, 2 not running. `--json` prints the same as JSON. [ADR-0019]
- **The status file** is not part of the records and is not copied to the records repo. [ADR-0019]
- **Health stays off the forge, the board and the records.** [ADR-0019]
- **Answering during a halt.** During a model halt, answers are recorded and writing criteria waits. An answer recorded just before a host halt keeps its comment as an intent, posted when the host is back, and the receipt says so. [ADR-0019]

### 17. Ticket states

The states and the transitions decided across the map: [GLOSSARY.md](../../GLOSSARY.md), [#18], [ADR-0006], [ADR-0008], [ADR-0011], [ADR-0014], [ADR-0016], [ADR-0018], [ADR-0020], [#21]

```
taken in ─▶ deciding ─┬─ oversized ─────────────────────────────▶ declined ■
                      ├─ cause or validity unknown ─────────────▶ investigating
                      ├─ repo's state settles nothing to do ────▶ cancelled ■
                      ├─ settled / unopposed, checks + challenge pass,
                      │  criteria written ──────────────────────▶ cleared
                      └─ needs the owner (incl. a criteria product
                         call or a failed check or challenge) ──▶ on the board
investigating ── findings arrive ─▶ deciding  (at most once)
on the board ─┬─ answer goes ahead ─▶ deciding (criteria only) ─▶ cleared
              ├─ "don't go ahead" ─▶ cancelled ■ (issue closed as not planned)
              └─ item withdrawn (edit, vision or pin change) ─▶ deciding
cleared ── a PR linking the issue is open and being checked ─▶ landing
landing ─┬─ landing check passes, merged ─▶ merged ■
         ├─ landing check fails ─▶ stays landing (checked again on a new head,
         │                         evidence section or criteria version)
         ├─ pinned path touched, all else passes ─▶ on the board
         └─ PR closed unmerged, no other PR open ─▶ cleared
cleared / landing ── flagged ─▶ re-check ─┬─ stands / goes ahead differently ─▶ same state
                                          └─ needs the owner ─▶ on the board
any non-final ── issue closed, deleted or moved elsewhere, or repo unenrolled ─▶ cancelled ■
the ticket's PR merged by someone other than entail ─▶ merged ■
```

Final states (■) stay final. An issue comes back only by being pulled in, as a new ticket. [ADR-0020]

## Testing Decisions

- **What makes a good test.** to-spec asks that tests check external behavior, not implementation details. The decisions fit this: the acceptance test checks only the forge and entail's store, and the forge adapters are tested as one contract on recorded responses. [ADR-0010], [ADR-0015]
- **Seams decided so far.**
  - **The `Forge` interface.** One contract test suite runs against both adapters on recorded responses. Self-hosted GitLab is covered by adapter tests on recorded responses with a non-gitlab.com host and a CE version string. [ADR-0015]
  - **The transport seam** under the adapters (CLI subprocess today). [ADR-0015]
  - **The notice connector.** The acceptance test uses a test connector to count notices. [#12], [#28]
  - **The real surfaces** for the acceptance test: the forge, entail's store, and the board form on localhost. [ADR-0010]
- **Unit tests named by the decisions.** [ADR-0010], [ADR-0016], [ADR-0020]
  - self-hosted GitLab's base URL (host) handling;
  - the rule that someone else's issue enters only through the owner's `/entail`;
  - the vision-change flag lookup, the merge guard (VISION.md and issue re-read), the landing trigger (head, evidence section, criteria version), and each re-check outcome;
  - the issue-edit comparison, each state's outcome on an edit, the `/entail` rules, and the new-ticket link.
- **The acceptance test.** [ADR-0010], [#28]
  - **Fixtures.** A pair of private fixture repos, one on GitHub and one on gitlab.com, holding the same tiny product `tally` (a word-count command-line tool in Node, tested with `node --test`, one CI job named `test`). Its 9-line VISION.md, starting code, settings and issues are recorded on [#28]. The harness resets them so the test can run again. It does not run on entail's own repo.
  - **Settings.** Generic criterion: the CI job `test` passes. Pin: "the output format", path `src/format.js`. Shadow off. Enrollment origin: stated by the owner.
  - **Who plays whom.** A scripted test executor watches for `entail:cleared` and `entail:investigate`, opens a prepared PR for each cleared issue and posts prepared findings for each investigated one. The harness answers board items through the real board form on localhost, as the owner.
  - **Runs.** 3 full runs on GitHub, and 1 on gitlab.com where every ticket must reach its expected outcome or differ only by an extra question. entail is restarted once in the middle of every run. Each run reports its model runs and estimated cost, with no threshold.
  - **Expected outcomes** (as amended under ADR-0011):

    | # | Issue | Expected path | End state |
    | --- | --- | --- | --- |
    | T1 | Read from standard input when no file is given | settled, citing the standard-input line; the first PR fails CI and gets a comment naming the unmet check; the fix merges | merged |
    | T2 | Print an error instead of a stack trace when a file is missing | settled, citing the errors line | merged |
    | T3 | Move the counting code into its own module | unopposed, fenced off `src/format.js` and VISION.md | merged |
    | T5 | Show the counts in colour | cleared (settled or unopposed); criteria require plain output when piped | merged |
    | T6 | Add a `--json` flag | cleared (settled or unopposed); criteria state one JSON object per input, one per line | merged |
    | T7 | Count the words of a web page given its URL | needs the owner (contradicts "tally never reaches the network."); answered "don't go ahead" | cancelled, issue closed as not planned |
    | T8 | Read default flags from `~/.tallyrc` | needs the owner (contradicts the configuration line); left unanswered | on the board |
    | T9 | Rename variables in `src/format.js` for readability | needs the owner (pin); answered "Rename only; keep every exported name and the printed output unchanged."; criteria cite the answer | merged |
    | T10 | Rewrite tally as a desktop app with a plugin system | declined, with a logged reason and an issue comment, and no board item | declined |
    | T11 | "Word counts are sometimes one too high", no reproduction | investigating; findings "a leading space counts as a word"; then settled, citing "A word is a run of characters between whitespace." | merged |
    | T13 | "Word counts differ from other tools on text with non-breaking spaces" | needs the owner (consequential readings); answered "Any Unicode whitespace separates words, including a non-breaking space."; criteria cite the answer | merged |

  - **Passing.** Across all runs, a ticket expected to need the owner, be declined or be ignored is never cleared. Clearing T7, T8, T9 or T13 without an answer is a wrong clear, and one wrong clear fails the test. Each ticket expected to be cleared is cleared in at least 2 of the 3 runs. Every extra board item is reported.
  - **Pass checks after each run** ([#28], [ADR-0010]):
    1. every ticket ends in its expected state, within the tolerance above;
    2. every call has exactly one audit record with its reason, its inputs (issue text, vision sha, pins and settings version, PR head sha for a landing check) and its model runs, and every state change has a call;
    3. every citation quotes whole lines that appear word for word in VISION.md at the recorded sha, its permalink resolves, and each expected-settled ticket's citation includes the expected line;
    4. nothing was invented: every criterion's source is known, VISION.md is unchanged, and no vision line was added;
    5. every comment opens with the attribution line, carries the hidden marker and has no line starting with `/`; each decision posted an intake comment with its vision check and then what happens next; comments for a raised item carry no question text;
    6. each board item raised produced exactly one notice, through the test connector, and one issue comment linking the board;
    7. entail merged only at the head sha its landing check verified, after `test` passed there; the failing T1 PR was not merged and got a comment naming what is missing; nothing merged for an unanswered, cancelled or declined ticket;
    8. the Calls page lists every call, and the records repo has a commit after the last answer;
    9. after the restart no ticket is lost, and no comment, label or merge is duplicated.
  - **Not in the acceptance test:** vision changes, issue edits and reopens (covered by unit tests), self-hosted GitLab and the `/entail` rule for someone else's issue (unit tests), and a second forge account. [ADR-0010], [ADR-0016], [ADR-0020]
- **Prior art.** The repo has no code yet. The one existing artifact is the board prototype, kept unmerged on the `prototype/board-page` branch (`prototypes/board-page.html`), the primary source for the board's layout and behavior. [ADR-0012], [#29]
- **After the test passes**, entail's own repo is the first real repo enrolled (dogfooding). This is not part of the gate. [ADR-0010], [#12]

## Out of Scope

All from the map's Out of scope list unless marked otherwise. [#12]

- Rulings learned from repeated board answers. They need answer history first.
- Scheduled drift checks of merged work against the current vision.
- Collaborators answering board items. MVP-1 serves the owner only, though every answer is stored with the answerer's name.
- Growing the vision automatically from board answers. An answer settles its ticket, and the owner adds vision lines by hand.
- Breaking an oversized ticket into smaller tickets. MVP-1 declines it. This is a recorded, owner-approved shortfall against VISION.md, and splitting is the next effort. [GLOSSARY.md](../../GLOSSARY.md)
- Vision authoring, which the /vision skill does.
- Executing tickets, running validation, pushing code and opening PRs, which belong to executors. [#24]
- Routing a failing PR beyond "do not merge, and comment what is missing": bounded retries, and closing a PR when its ticket is cancelled.
- Work management, such as cleared issues nobody picks up, or which work is waiting, ready, cancelled or held. That is a separate project. [#33]
- Hosting, webhooks, GitHub or GitLab apps, CI-hosted runs, and reaching the board remotely.
- GitHub Enterprise Server. [ADR-0015]
- Native Windows. [ADR-0017]
- A watchdog that notices when entail is not running. [ADR-0019]
- A budget or cost cap on model runs. Costs are reported with no threshold. [ADR-0017], [ADR-0010]
- Pruning records. [ADR-0009]

## Further Notes

- **How this spec was assembled.** It follows the to-spec template from the wayfinder skill set, with the map as its only source. Two of to-spec's steps were not done here, because the task asked for a repo document and allowed no new decisions: it was not published as an issue labelled `ready-for-agent`, and the seams under Testing Decisions were not confirmed with the owner (see Open points).
- **Statements this spec replaces.** Where an earlier record disagrees with a later decision, the spec follows the later one:
  - The **small** verdict (category list, high-stakes exclusions, `category`/`why_small`/`why_reasonable`, and "vision silent" as a `why_raised`) on [#18], [#19], [#21] and ADR-0002 is replaced by **unopposed**. [ADR-0011]
  - "If two open PRs link the same issue, entail checks the newest" on [#18] is replaced by "each is checked, and the first to pass merges". [ADR-0014], which [ADR-0013] handed this question to.
  - "An issue has at most one ticket" on [#18] became "at most one ticket in flight". [ADR-0020]
  - "Investigation happens inside the executor's PR" on [#21] is replaced by the investigating state. [ADR-0006]
  - The map's note on self-hosted GitLab "with its own base URL and token", and [#31]'s identity comment about a token and base URL in the forge setting, are replaced by a forge setting with no credentials or base URL, reached through `glab`. [ADR-0015]
  - "If `git` or `claude` fails at start, nothing runs" (exit) and enrolling through `entail` commands in ADR-0017 are replaced by staying up with the halt shown [ADR-0019] and by the Repos page [ADR-0018].
  - "A settled ticket is flagged only when its cited line is removed" on [#20] is replaced by "any line added, or a cited line removed". [ADR-0016]
- **Research behind the decisions.** [#13] (what /vision writes), [#14] (GitHub and GitLab APIs for polling), [#15] (driving Claude locally), [#16] (how executors could notice cleared issues) and [#17] (what no-mistakes gates) informed the decisions above and add no requirements of their own.

## Open points

These were found while assembling the spec. None is decided here.

1. **Seam confirmation.** to-spec asks for the testing seams to be checked with the owner. The seams above come from recorded decisions only and have not been confirmed.
2. **No seam for model runs.** The unit tests that ADR-0016 and ADR-0020 name, for each re-check outcome, imply a way to substitute the `claude -p` runner, but no seam for model runs is decided.
3. **Can findings be a criterion's source?** The glossary and ADR-0005 list a criterion's sources as the issue, a vision line or the owner's answer. T11 is cleared from investigation findings, and ADR-0006 says a ticket whose fix is known from findings "gets its criteria", but findings are not on the source list. Whether a criterion may cite findings, or must trace to the issue, is not stated.
4. **Acceptance pass check 4 still names "a small category".** [#28]'s pass check 4 allows a criterion source of "a small category", which no longer exists after ADR-0011. The amendment on [#28] did not restate this check. The spec says "every criterion's source is known", without deciding the list.
5. **T2's alternative path.** [#28] says for T2 "settled, citing the errors line (small is also acceptable)". The ADR-0011 amendment restated T3, T5, T6, T9 and T13 but not T2, so whether unopposed is an acceptable path for T2 is not recorded. The spec lists T2 as settled only.
6. **Does entail close a declined ticket's issue?** A declined ticket gets a logged reason and an issue comment, and the ticket is final, but whether entail closes the issue is not stated. T10's expected end state says only "declined".
7. **A PR linking an issue whose ticket is final.** ADR-0013 says a PR linking an issue with no criteria in force (deciding, on the board or investigating) gets one comment. Comments are decided for a merged ticket (ADR-0014) and for "don't go ahead" after a re-check (ADR-0016). Nothing is decided for a PR that links a declined ticket, or one cancelled in another way.
8. **The model setting is not in the global settings list.** [#19] and [#21] set Opus 5.5 "once in entail's global config", but ADR-0018's list of entail-wide settings does not include the model, and ADR-0018 says the global settings' "content is decided elsewhere". No ticket decided that content or the global settings page's layout.
9. **The notice connector's interface.** Notice delivery is "a pluggable connector" [#12], with a desktop connector and a test connector, but its interface is not decided.
10. **VISION.md's "fix it itself".** VISION.md says "When a PR fails its criteria, entail decides whether to fix it itself, raise it again, or cancel it." [#24] decided that entail never executes, and the map puts routing a failing PR after MVP-1. Declining oversized tickets is recorded as an owner-approved shortfall against VISION.md, but "fix it itself" against "entail never executes" is not recorded as a shortfall or as a VISION.md reading. VISION.md is unchanged by this spec.

[#12]: https://github.com/omkarbhale/entail/issues/12
[#13]: https://github.com/omkarbhale/entail/issues/13
[#14]: https://github.com/omkarbhale/entail/issues/14
[#15]: https://github.com/omkarbhale/entail/issues/15
[#16]: https://github.com/omkarbhale/entail/issues/16
[#17]: https://github.com/omkarbhale/entail/issues/17
[#18]: https://github.com/omkarbhale/entail/issues/18
[#19]: https://github.com/omkarbhale/entail/issues/19
[#20]: https://github.com/omkarbhale/entail/issues/20
[#21]: https://github.com/omkarbhale/entail/issues/21
[#22]: https://github.com/omkarbhale/entail/issues/22
[#24]: https://github.com/omkarbhale/entail/issues/24
[#28]: https://github.com/omkarbhale/entail/issues/28
[#29]: https://github.com/omkarbhale/entail/issues/29
[#31]: https://github.com/omkarbhale/entail/issues/31
[#33]: https://github.com/omkarbhale/entail/issues/33
[ADR-0001]: ../adr/0001-issue-text-is-never-the-owners-word.md
[ADR-0002]: ../adr/0002-automatic-verdicts-pass-checks-and-a-challenge.md
[ADR-0003]: ../adr/0003-vision-lines-are-identified-by-their-exact-text.md
[ADR-0004]: ../adr/0004-a-vision-lines-origin-is-recorded-by-its-writer.md
[ADR-0005]: ../adr/0005-criteria-are-outcomes-with-mechanical-checks-and-no-sign-off.md
[ADR-0006]: ../adr/0006-unknown-problems-are-investigated-before-criteria.md
[ADR-0007]: ../adr/0007-the-intake-comment-opens-with-a-vision-check.md
[ADR-0008]: ../adr/0008-board-answers-come-only-through-the-board-form.md
[ADR-0009]: ../adr/0009-records-live-in-a-local-store-copied-to-a-records-repo.md
[ADR-0010]: ../adr/0010-the-acceptance-test-runs-on-fixture-repos-and-fails-on-any-wrong-clear.md
[ADR-0011]: ../adr/0011-a-ticket-the-vision-does-not-contradict-and-no-pin-touches-is-cleared.md
[ADR-0012]: ../adr/0012-the-board-is-an-inbox-and-answers-are-reviewed-before-they-are-recorded.md
[ADR-0013]: ../adr/0013-executors-work-from-labels-and-report-evidence-and-findings-by-id.md
[ADR-0014]: ../adr/0014-the-landing-check-grades-evidence-with-a-challenge-and-merges-only-what-was-asked.md
[ADR-0015]: ../adr/0015-forges-sit-behind-one-adapter-reached-through-the-owners-clis-with-repository-content-read-from-git.md
[ADR-0016]: ../adr/0016-a-flagged-ticket-is-re-checked-in-place-and-waits-to-merge.md
[ADR-0017]: ../adr/0017-one-local-process-re-derives-owed-work-from-its-records-on-every-pass.md
[ADR-0018]: ../adr/0018-repos-are-enrolled-and-set-on-a-local-repos-page-with-settings-kept-in-entails-records.md
[ADR-0019]: ../adr/0019-entail-shows-its-own-health-where-the-owner-looks-and-interrupts-only-for-halts-they-must-fix.md
[ADR-0020]: ../adr/0020-an-edited-issue-is-re-checked-in-place-and-a-finished-issue-comes-back-only-when-the-owner-pulls-it-in.md
