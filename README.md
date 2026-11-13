# entail

entail is the owner's stand-in for product decisions on a repo. The test it applies to every change is one question: does this make the product better? The repo's `VISION.md` is the owner's word on what better means. Each issue gets one of three answers: go, with the few criteria an implementer would not guess; no, closed with the reason; or ask, which brings it to the owner. A PR merges when it solves its ticket's problem, meets what was asked and leaves the product better. Every call is recorded with its reason.

## Status

entail is being rebuilt. On 2026-11-12 it was started over in this repository around those two judgments, one per issue and one per PR; the first build made wrong calls, and [docs/restart-2026-11-12.md](docs/restart-2026-11-12.md) says why, what carried over and where the old tree is in history. The call on an issue and the call on a PR work: entail watches enrolled repos, posts each call on its issue, judges each PR that closes an issue it said go on, merges it at the judged head or sends it back with what needs to change, takes the owner's confirmations, overrides and answers on its board or from the command line, and hands each go to a command the owner sets to start the work. It runs as a per-user service, so it keeps going without a terminal.

## Use

You need Node 24 or newer, `git`, `gh` logged in, and `claude` logged in.

```sh
npm ci && npm run build
node dist/cli.js enroll owner/repo             # watch a repo; it starts in confirm mode
node dist/cli.js run --dry-run                 # one pass that prints what it would post, and changes nothing
node dist/cli.js service install               # run entail now, at every login and after a crash
node dist/cli.js open                          # the board, on http://127.0.0.1:4380/
node dist/cli.js status                        # running or not, each repo's last check and confirm mode, what waits
node dist/cli.js settings --notice '<command>' # optional: told in one line when something starts waiting
node dist/cli.js settings --start '<command>'  # optional: a go hands its issue to this command to start the work
```

From there the owner files issues and answers on the board; nothing else needs a terminal. The rest is there when wanted:

```sh
node dist/cli.js run                           # entail by hand instead of the service: poll every minute, post, serve the board
node dist/cli.js service status                # or: service uninstall, which stops and removes it
node dist/cli.js waiting                       # the questions and calls to confirm waiting on you
node dist/cli.js confirm owner/repo#12         # or: override owner/repo#12 no "reason", answer owner/repo#12 go "answer"
node dist/cli.js calls owner/repo              # the log: every call and every answer, with its reason
node dist/cli.js judge owner/repo#123          # the call on one issue, printed; it posts nothing
node dist/cli.js land owner/repo#124           # the call on one PR at its head, printed; it posts and merges nothing
node dist/cli.js replay                        # the case book through both judgments, agreement with the owner
```

`node dist/cli.js help` lists every command and option.

**Running.** `entail service install` writes a systemd user unit (Linux, WSL with systemd on), a launchd agent (macOS) or a Task Scheduler task (Windows) that runs the same `entail run`, with the same data directory and port, from login on and again after a crash; `entail service uninstall` stops and removes it, and `entail service status` says where it stands. Task Scheduler does not restart a crashed task, so on Windows log in again or run `entail service install` again to restart it. One copy runs per machine: the service and `entail run` by hand never run together. A crash or a restart loses nothing: every call and owner's action is in the log before entail acts on it, an action whose undo window closed meanwhile is completed, an undone one is dropped, and a comment already posted is found by its marker and never posted twice.

**Watching.** `run` polls each enrolled repo. Each issue filed after it was enrolled gets a call, and gets one again whenever its title or body is edited; a comment with a line starting `/entail` gets a call on its issue too, on any issue. Each call is one model run, Opus 5.5 at high effort unless the settings say otherwise (`entail settings`, for every repo or one), paid on the logged-in `claude`.

**Acting on the call.** The call is posted on the issue, opening with "Speaking from <owner>'s entail:". A go carries its reason and the criteria the PR must meet. A no carries its reason, quotes the vision lines it rests on, and closes the issue as not planned. An ask posts only a note that a question is waiting on the board; the question and its answer stay off GitHub. Every comment carries a hidden marker with the id of the log entry it speaks for, so a restart finds what it already posted and never posts it twice.

**Landing a PR.** `run` also follows each open PR that GitHub's own link data says closes an issue entail called go on. Once CI has finished at a head entail has not judged, one model run reads the issue, the vision, the criteria the go set, the diff, the checks and the changed files (both read from GitHub, never from the PR's description) and answers merge, send back or ask, with a plain reason. Each criterion is marked met or unmet with the evidence relied on, and anything the PR does beyond its criteria is sorted needed (to do the job), harmless or unwanted; only something unwanted, an unmet criterion, the problem unsolved or CI not green sends a PR back. A merge happens at the exact head that was judged, squashing unless the repo allows only other methods; a new push is judged again. Two rules no model decides: a PR whose CI is not green at the judged head is never merged, and a PR that changes `VISION.md` or a pinned path (a pin naming a path, such as `src/billing/`) merges only on the owner's answer. A send-back is posted on the PR as what needs to change; entail never changes the PR itself. After three send-backs, the next one cancels the PR: it is closed with the reason, and when what blocked it is a product call, the issue's question goes to the owner. The prompt is in `src/landing.ts`.

**Confirm mode.** A repo starts in confirm mode: entail posts its go or no but closes nothing until the owner confirms it. The owner can instead override a call with their own go or no and a reason, which is posted on the issue (reopening it for a go) and replaces the call. A question is answered with the owner's go or no and their words; on a go the judgment runs again with the answer as the owner's word, for the criteria. A go can also be overridden with a go made differently: the owner's one line is posted word for word as the criterion, in place of entail's. On a PR the same happens with merge or send-back: in confirm mode a merge call is posted but nothing is merged until the owner confirms it, and a cancel closes nothing until confirmed. Every confirmation, override and answer is recorded under the owner's name and written as a case to the owner's case book. The owner turns confirm mode off per repo (on the board, or `entail settings owner/repo --confirm off`) once entail stops being overridden; the board suggests it after five checked calls with at least 80% confirmed, counting confirmations and overrides only, on issues and PRs alike.

**The board.** `run` serves the board on `http://127.0.0.1:4380/`: every enrolled repo and every call, on issues and PRs, in one place, on three pages that never reload. **Waiting** is one column of open cards, questions first and then calls to confirm, oldest first within each; each card says what the ticket (or the PR) was, what entail concluded, why it was raised and the vision line or past case it rests on, and is confirmed, overridden with a one-line reason, or answered in place (`j`/`k` move, `c` confirm, `o` override, `a` answer, `Esc` cancel, `1`/`2`/`3` switch pages). A PR's card says merge or send back, shows the criteria as a met/unmet checklist with evidence, a line from GitHub (CI checks, whether `VISION.md` was touched) that does not come from the PR, and, collapsed, what the PR does beyond its criteria. An action is recorded at once and held for ten seconds with an Undo, on an issue and on a PR alike; entail writes it to the case book and acts on GitHub (posts, closes or merges) when the window closes, and a restart completes it without acting twice. **Log** is every call on issues and PRs, newest first and paged by day, never trimmed, with the owner's call kept beside entail's; a call entail made alone can be overridden from it. **Repos** holds enrolling (with the issues already open offered as a separate click), confirm mode, the model and effort (one default, overridable per repo), the pins as read from their file, and the notice command as set (read only). The tab title carries the count. The board is a React app built into `dist/board` by `npm run build`, and its source is in `board/`.

**Notices.** When something starts waiting, entail can run one command the owner sets (`entail settings --notice '<command>'`, or `--notice none`; the board shows it but does not set it) with one line and a link appended as its last two arguments (`/bin/sh -c`, so `$1` and `$2`; on Windows `cmd.exe /d /s /c`, so `%~1` and `%~2` in a batch file), such as `entail: 1 question and 3 calls to confirm waiting on you http://127.0.0.1:4380/#/waiting`; never the question itself. [`examples/`](examples/) holds a command that appends the line to a file (`notice-to-file.sh`, or `notice-to-file.cmd` on Windows) and one that drops it into firstmate's inbox. By default there is none.

**Starting work.** When a go acts (at once with confirm mode off; once the owner confirms it, answers go or overrides to go when it is on), entail can run one command the owner sets (`entail settings --start '<command>'`, or `--start none`; the board shows it but does not set it) with `/bin/sh -c` (`cmd.exe /d /s /c` on Windows) and the handoff on standard input as one line of JSON: the repo, the issue's number, URL and title, the call's reason, the criteria with their sources, and the `VISION.md` commit. Never on a no or an ask. Work is not started twice for an issue (a later go retries only after a start that failed); the log records that it started, by which command and with what exit status, and a command that fails is recorded and never holds up the call. entail depends on no executor: [`examples/start-to-file.sh`](examples/start-to-file.sh) (or [`start-to-file.cmd`](examples/start-to-file.cmd) on Windows) appends the handoff to a file. The PR that later closes the issue is judged at landing like any other. By default there is none.

**The board's API.** The board reads and writes through a small JSON API on the same address, the single path that records answers; the browser never talks to GitHub. It serves what is waiting and what is held in its undo window (`GET /api/waiting`), the log by day (`GET /api/log`), one call (`GET /api/calls/:id`), confirm, override, answer and undo (`POST /api/calls/:id/confirm|override|answer|undo`), the repos (`GET|POST /api/repos`, `PATCH|DELETE /api/repos/:owner/:name`, `POST /api/repos/:owner/:name/check|backlog`), the settings (`GET|PATCH /api/settings`), entail's status (`GET /api/status`) and live updates as server-sent events (`GET /api/events`). `src/api.ts` documents each. Each call it returns carries `kind`, "issue" or "pr"; a PR's call also carries `pr`, with the criteria checklist, the facts read from GitHub, the beyond-the-criteria sort and what entail did on the PR. It answers only on the loopback host, and takes writes only as JSON from no other origin.

**What entail keeps.** Everything lives in entail's data directory (`~/.local/share/entail` on Linux, `~/Library/Application Support/entail` on macOS, `%LOCALAPPDATA%\entail` on Windows): one append-only log per repo in `log/github.com/<owner>/<name>.jsonl` holding every enrollment, setting, call on an issue or a PR (with what it read), owner's action, post and merge, from which everything shown is derived; the owner's case book in `cases/`; pins in `pins/<host>/<owner>/<name>.md`, one topic per line; which waiting items the owner was last told about in `notices.json`; the lock held by the running copy in `entail.lock`; and the settings, mirrors, cursors and operational log.

`judge` reads the issue and its comments, the repo's `VISION.md` and the repo itself at its default branch, the owner's pins for the repo, and the most relevant past cases, and answers go (with the criteria the PR must meet), no (with the reason) or ask (with the one question). A change that is large or hard to undo is always ask. The prompt is in `src/judgment.ts`.

The case book is [`cases/`](cases/) and the owner's own `cases/` in the data directory, whose cases win for the same issue: each case holds the issue as it stood (`issue.md`), `VISION.md` at the commit the call was made against (`vision.md`), and the owner's call with its reason and where that reason comes from (`call.md`). A landing case, marked `kind: landing` in its `call.md`, is the owner's merge or send-back on a PR: it adds the criteria the PR was judged against (`criteria.md`), the PR's title and description (`pr.md`) and the checks and changed files read from GitHub (`facts.json`), and names the judged head and base, from which the diff is read again. While the book holds eight cases or fewer, every case is precedent in the prompt; past that, the eight that are the same repo's and share the most words with the issue. `replay` runs at low effort unless `--effort` says otherwise and judges each one against its own vision and every other case of its kind, issue cases through the call on an issue and landing cases through the call on a PR, and prints the disagreements first. A change to how entail judges is checked by replaying the book.

## Why

Agents can implement. What is missing is a durable record of what the product is and someone to make the product call on each ticket and each PR the way the owner would, so that today every decision comes back to the owner in chat and evaporates there. entail never writes code, pushes or opens PRs; on the forge it only comments, labels, closes and merges. More in [PROBLEM.md](PROBLEM.md) and [VISION.md](VISION.md).

## Development

You need Node 24 or newer and `git`.

```sh
npm ci
npm run typecheck
npm test        # node:test on the TypeScript sources, then the board's component tests (vitest)
npm run build   # compiles to dist/ and builds the board into dist/board
npm run board:dev  # the board with hot reload, against a running entail run on port 4380
```

The tests run no real model and reach no real forge: model runs are scripted, the GitHub adapter is tested against recorded responses, and the board's pages are tested against a fake of its API.
