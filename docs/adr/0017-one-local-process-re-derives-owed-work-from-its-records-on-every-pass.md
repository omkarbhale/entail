# One local process re-derives the work it owes from its records on every pass

> **Amended by ADR-0018.** Enrolling a repo, changing its settings, pausing it and unenrolling it happen on the Repos page served by the running process, not through separate `entail` commands. The commands that open the store directly are what remains, such as status.

entail is one long-running TypeScript process on Node 24, `entail run`, and only one copy runs per machine. Every 60 seconds it runs a **pass** over each enrolled repo:

1. It reads what changed on the forge.
2. For every ticket that is not final, it works out the next step the ticket is owed from its records and the latest forge state.
3. It starts that step unless it is already running.

There is no job queue. Work owed is a function of the records, so a restart loses nothing and repeats nothing. ADR-0010's acceptance test restarts entail midway through every run and checks exactly that. The same process serves the board, the Calls page and the ticket pages on 127.0.0.1.

**Starting and keeping it running** (owner). `entail run` runs in the foreground, in a terminal or tmux. `entail service install` optionally registers the same command as a per-user background service, a systemd user unit on Linux and WSL or a launchd agent on macOS. The service starts at login and restarts after a crash, and `entail service uninstall` removes it. Only one copy runs per machine, so a second `entail run` refuses to start. entail runs on one machine at a time, because two machines would both post on the same issues. While it is stopped, nothing is taken in, decided or merged, and it catches up from its cursors when it starts again.

**Sharing the owner's Claude subscription** (owner). Model runs use the same subscription as the owner's own chats. entail runs at most two at a time and has no budget of its own. When the subscription reports its usage limit, all model work pauses until the limit resets. Tickets stay deciding or landing, nothing goes to the board, and the pause is logged. ADR-0010 already reports each run's estimated cost, so the owner can see what entail spends before deciding a cap is needed.

## Considered options

- **A foreground command only, or a service only**: passed over by the owner in favour of both.
- **A daily cap on entail's estimated cost, or one model run at a time**: passed over by the owner. Two runs and no budget, pausing at the subscription's own limit, keeps decisions moving, and the cost per run is already reported.
- **A persisted job queue**: rejected. It duplicates what a ticket's state and records already imply, and after a crash the queue and the records can disagree.
- **Go, for a single binary**: rejected. The pages are server-rendered HTML, the board prototype is already a single HTML page, and Claude's TypeScript Agent SDK stays available if the `claude -p` subprocess ever has to change. **Python** offered no advantage.
- **Polling every 15 seconds**: rejected. It costs four times the GitLab requests and `gh` subprocesses, for a first comment nobody waits on. **Every 5 minutes**: rejected, because the owner would wait noticeably for an intake comment.
- **Routing every `entail` command through the running process's HTTP API**: rejected. It would add a second API to secure, and enrolling or changing settings would then need entail running.
- **Picking a free port when the board's port is taken**: rejected, because the links in notices and issue comments must keep working across restarts.

## Consequences

- **Stack.**
  - entail is one npm package with one `entail` command, written in TypeScript for Node 24 LTS.
  - The store uses Node's built-in `node:sqlite`, so there is no native addon to build.
  - The pages are server-rendered HTML from `node:http`, with a little inline script and no front-end framework or UI build step.
  - Verdict, criteria and grade schemas are written once in TypeScript and emitted as the JSON Schema passed to `claude -p --json-schema`.
  - Tests use `node:test`.
  - Linux (WSL included) and macOS are supported. Native Windows is out of MVP-1.
- **Data directory.** One per-user directory holds the store, the records repo, the git mirrors, the operational log and the lock that keeps one copy running. It is `$XDG_DATA_HOME/entail` (by default `~/.local/share/entail`) on Linux and WSL, and `~/Library/Application Support/entail` on macOS.
  - Other `entail` commands, such as enrolling, settings and status, open the store directly, in WAL mode with a busy timeout, in short transactions.
  - The running process re-reads settings on every pass, so a change takes effect within a minute without any IPC.
- **The pass.**
  - Each enrolled repo is polled every 60 seconds on both forges, with ADR-0015's change detection. An idle GitLab repo costs about three API requests a minute.
  - Each pass checks the default branch's head with `git ls-remote`. It fetches the mirror only when that head moved, which is how a vision change is seen, or when a PR head is needed.
  - A landing PR's checks are read on the same pass, so a PR is checked within about a minute of its checks finishing.
  - At most four forge subprocesses run at once, across all repos.
  - A rate-limit response is honoured until its reset time. Any other failure backs off that repo alone, doubling up to 15 minutes, so one unreachable self-hosted GitLab never stalls the others.
  - The interval is an entail-wide setting.
- **Forge writes.** Every comment, label, close and merge is recorded as an intent before it is sent and confirmed after it, generalising ADR-0015's rule for comments. On start, entail settles every unconfirmed intent by reading the forge before its first pass:
  - a comment is found by its hidden marker;
  - a merge is found by the PR's state;
  - labels and closes are simply applied again.
- **Model runs.**
  - A ticket has at most one model step running at a time. A verdict and its challenge, or a grade and its challenge, run one after the other.
  - Waiting runs go in priority order: landing checks first, because they finish work, then criteria after an answer, then new intake. Within each group, the oldest goes first.
  - Each run has a 10-minute timeout: entail sends SIGINT so the turn ends cleanly, then SIGTERM after a grace period.
  - A machine failure (ADR-0002) is retried after 1, 2, 4… minutes, capped at 30, with no attempt limit. It is logged to the operational log and never reaches the board.
  - A run in flight when entail stops is discarded and run again on the next start.
  - At most two model runs go at once across all repos, an entail-wide setting (owner). A usage-limit failure pauses every model run until the reset time `claude` reports, or for 30 minutes if it reports none.
- **The board server.** It listens on 127.0.0.1 only, on port 7419 by default (an entail-wide setting), and refuses to start if the port is taken. The answer form is the only path by which the owner's word enters entail (ADR-0008), so no other web page open in the same browser may forge an answer. The server:
  - refuses any request whose `Host` is not its own address, which defeats DNS rebinding;
  - refuses any write whose `Origin` is not its own;
  - requires a token, issued when the process starts, on every form.

  There is no login, because the machine is the owner's. Reaching the board remotely stays out of MVP-1.
- **Start.**
  1. Take the lock.
  2. Open the store.
  3. Check that `git` and `claude` are present and logged in. If either fails, nothing runs, and entail says why.
  4. For each enrolled host, check that `gh` or `glab` is logged in as the account recorded at enrollment (ADR-0015). A failing host pauses only its own repos.
  5. Run ADR-0009's check for marked issues with no records.
  6. Settle unconfirmed intents.
  7. Start the board server, then the passes.
- **Stop (SIGINT or SIGTERM).**
  1. Start no new work.
  2. Interrupt model runs.
  3. Wait up to 10 seconds for in-flight forge writes to confirm. Any left unconfirmed are settled on the next start.
  4. Commit and push the records repo, which is otherwise committed after every answer and at least hourly (ADR-0009). A failed push is logged and retried on the next commit.
  5. Release the lock.
- **Desktop notice.**
  - Linux: `notify-send`.
  - macOS: `osascript`.
  - WSL: a Windows toast through `powershell.exe` interop, because the owner's desktop there is Windows and `notify-send` usually reaches nothing. WSL is detected from the kernel release.
  - A failed notice is logged and blocks nothing. The issue comment linking to the board is still posted.
- **Operational log.** Polls, backoffs, retries, machine failures, pauses at the usage limit and failed notices are not calls (ADR-0009). They go to a JSON-lines file in the data directory, rotated at 10 MB with five files kept, and the same lines go to stdout for a terminal or the system journal. How the process reports its own health to the owner is a separate question.
- Decided on [What is the shape of entail's local process?](https://github.com/omkarbhale/entail/issues/27).
