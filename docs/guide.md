# entail user guide

The reference for running entail: every command, what it does on the forge, the board, and where it keeps its data. The [README](../README.md) is the short version.

## Commands
You need Node 24 or newer, `git`, `gh` logged in (or `glab`, for GitLab), and `claude` logged in.

```sh
npm ci && npm run build
node dist/cli.js enroll owner/repo             # watch a repo; it starts in confirm mode
node dist/cli.js run --dry-run                 # one pass that prints what it would post, and changes nothing
node dist/cli.js service install               # run entail now, at every login and after a crash
node dist/cli.js open                          # the board, on http://127.0.0.1:4380/
node dist/cli.js status                        # running or not, each repo's last check and confirm mode (and, while its checks fail, since when and why), what waits
node dist/cli.js settings --notice '<command>' # optional: told in one line when something starts waiting
node dist/cli.js settings --start '<command>'  # optional: a go hands its issue to this command to start the work
node dist/cli.js settings --backup <git remote> # optional: push the records to a git remote after each pass
```

From there the owner files issues and answers on the board; nothing else needs a terminal. The rest is there when wanted:

```sh
node dist/cli.js run                           # entail by hand instead of the service: poll every minute, post, serve the board
node dist/cli.js service status                # or: service uninstall, which stops and removes it
node dist/cli.js update                        # from entail's checkout: pull, build, restart the running entail on the new code
node dist/cli.js waiting                       # the questions and calls to confirm waiting on you
node dist/cli.js confirm owner/repo#12         # or: override owner/repo#12 no "reason", answer owner/repo#12 go "answer"
node dist/cli.js calls owner/repo              # the log: every call and every answer, with its reason
node dist/cli.js judge owner/repo#123          # the call on one issue, printed; it posts nothing
node dist/cli.js land owner/repo#124           # the call on one PR at its head, printed; it posts and merges nothing
node dist/cli.js replay                        # the case book through both judgments, agreement with the owner
node dist/cli.js backup status                 # the backup remote, its last push, and whether backup is stuck
node dist/cli.js restore <git remote>          # on a new machine: bring the records back from the backup remote
```

`node dist/cli.js help` lists every command and option.

## GitLab

A project on gitlab.com is served the same as a GitHub repo, with nothing left out: name it `gitlab:group/project` (subgroups included, as in `gitlab:acme/tools/tally`, or paste its `https://gitlab.com/...` address) wherever this page says `owner/repo`, on the command line and on the board's Repos page, and have `glab` logged in (`glab auth login`) beside or instead of `gh`. Everything below works there: calls, labels and marked comments on issues, `/entail` in a note, merge requests followed through GitLab's own "closes" link, CI read from the merge request's head pipeline and the changed files from its diffs (both from GitLab, never from the description), and merging at the judged head with the project's own merge method. GitLab records no close reason, so a no closes the issue plainly with its comment saying why, and when "Pipelines must succeed" is on the pipeline is the check GitLab requires. GitHub repos keep their names and their logs as before.

## Running

`entail service install` writes a systemd user unit (Linux, WSL with systemd on), a launchd agent (macOS) or a Task Scheduler task (Windows) that runs the same `entail run`, with the same data directory and port, from login on and again after a crash; `entail service uninstall` stops and removes it, and `entail service status` says where it stands. Task Scheduler does not restart a crashed task, so on Windows log in again or run `entail service install` again to restart it. One copy runs per machine: the service and `entail run` by hand never run together. A crash or a restart loses nothing: every call and owner's action is in the log before entail acts on it, an action whose undo window closed meanwhile is completed, an undone one is dropped, and a comment already posted is found by its marker and never posted twice.

## Updating

`entail update`, run from entail's checkout, fast-forwards its branch (`git pull --ff-only`), runs `npm ci` and `npm run build`, and restarts the entail running from that checkout on the new code. Before the restart it asks the running entail to take no new work and waits for the pass in flight to finish, model runs and start commands included, so nothing is cut off partway; what comes due meanwhile is acted on after the restart. The service is restarted through its service manager and the board comes back with it; `entail run` by hand is stopped once idle, for you to start again. It refuses a directory that is not entail's checkout, uncommitted changes to tracked files, and an entail running from anywhere else, and a failed pull or build leaves the running entail alone.

## Watching

`run` polls each enrolled repo. Each issue filed after it was enrolled gets a call, and gets one again whenever its title or body is edited; a comment with a line starting `/entail` gets a call on its issue too, on any issue. Each call is one model run, Opus 5.5 at high effort unless the settings say otherwise (`entail settings`, for every repo or one), paid on the logged-in `claude`.

## Acting on the call

The call is posted on the issue, opening with "Speaking from <owner>'s entail:". A go carries its reason and the criteria the PR must meet, always ending with one entail adds itself: link the PR to the issue so GitHub lists it under the PR's Development section (for example `Closes #N` in its description), since entail does not pick up a PR that is not linked. That line is not stored in the log or given to the landing call; whether a PR is linked is read from GitHub, never from the PR's claim. A no carries its reason, quotes the vision lines it rests on, and closes the issue as not planned. An ask posts only a note that a question is waiting on the board; the question and its answer stay off GitHub. Every comment carries a hidden marker with the id of the log entry it speaks for, so a restart finds what it already posted and never posts it twice. As a call acts, the issue also gets one label: `entail:go` for a go, `entail:no` for a no as it closes, and `entail:ask` while a question waits on the board, swapped for the next one when an answer, an override or a changed call acts; a label GitHub refuses holds the act for a retry next pass, and only an account that cannot label (it lacks triage access, or the repo has issues off) lets the call go ahead without one, with `entail status` and the board's repo card saying why.

## Blocked issues

An issue blocked by another issue that is still open gets no call, no criteria and no work. It is blocked when its title or body says so ("blocked by #12", "depends on #12", or `owner/name#12` for another repo, case-insensitive, outside code) or when the forge links it to a blocking issue (GitHub's issue dependencies); whether each blocker is open is always read from the forge. entail holds the issue instead: it posts one comment naming the open blockers and saying it picks the issue up again when the issue is edited (for example to remove a blocker), on an `/entail` comment, or when the blockers close, and puts on the `entail:blocked` label. A held issue is weighed again when it changes, when GitHub reports a change to one of its blockers in the same repo, and, for a blocker in another repo, by reading that blocker's state each pass; while the same blockers stay open nothing new is posted, and a changed set of blockers, or an `/entail` comment, posts a new note. Once none is open the issue is judged as usual and the call's label replaces `entail:blocked`. Where GitHub's dependencies cannot be read, only the text counts and the note says so. On a GitLab project the forge's links are the issue's links of type "is blocked by", which only GitLab Premium and up can make; on the Free tier none blocks, so the text names the blockers, and each blocker's state is read from GitLab. A hold is not a call: nothing waits on the owner for it, confirm mode does not touch it, and it shows in `entail calls`, in `entail status` and on the repo's card, and in the trail of the call that follows it on the board's Log.

## Landing a PR

`run` also follows each open PR that GitHub's own link data says closes an issue entail called go on. Once CI has finished at a head entail has not judged, one model run reads the issue, the vision, the criteria the go set, the diff, the checks and the changed files (both read from GitHub, never from the PR's description) and answers merge, send back or ask, with a plain reason. Each criterion is marked met or unmet with the evidence relied on, and anything the PR does beyond its criteria is sorted needed (to do the job), harmless or unwanted; only something unwanted, an unmet criterion, the problem unsolved or CI not green sends a PR back. A merge happens at the exact head that was judged, squashing unless the repo allows only other methods; a new push is judged again. Two rules no model decides: a PR whose CI is not green at the judged head is never merged, and a PR that changes `VISION.md` or a pinned path (a pin naming a path, such as `src/billing/`) merges only on the owner's answer. A send-back is posted on the PR as what needs to change; entail never changes the PR itself. After three send-backs, the next one cancels the PR: it is closed with the reason, and when what blocked it is a product call, the issue's question goes to the owner. The prompt is in `src/landing.ts`.

## Confirm mode

A repo starts in confirm mode: entail posts its go or no but closes nothing until the owner confirms it. The owner can instead override a call with their own go or no and a reason, which is posted on the issue (reopening it for a go) and replaces the call. A question is answered with the owner's go or no and their words; on a go the judgment runs again with the answer as the owner's word, for the criteria. A go can also be overridden with a go made differently: the owner's one line is posted word for word as the criterion, in place of entail's. On a PR the same happens with merge or send-back: in confirm mode a merge call is posted but nothing is merged until the owner confirms it, and a cancel closes nothing until confirmed. Every confirmation, override and answer is recorded under the owner's name and written as a case to the owner's case book. The label follows the confirmation: a call waiting to be confirmed carries none, and its `entail:go` or `entail:no` goes on when the owner's confirmation, override or answer acts. The owner turns confirm mode off per repo (on the board, or `entail settings owner/repo --confirm off`) once entail stops being overridden; the board suggests it after five checked calls with at least 80% confirmed, counting confirmations and overrides only, on issues and PRs alike.

## The board

`run` serves the board on `http://127.0.0.1:4380/`: every enrolled repo and every call, on issues and PRs, in one place, on three pages that never reload. **Waiting** is one column of open cards, questions first and then calls to confirm, oldest first within each; each card says what the ticket (or the PR) was, what entail concluded, why it was raised and the vision line or past case it rests on, and is confirmed, overridden with a one-line reason, or answered in place (`j`/`k` move, `c` confirm, `o` override, `a` answer, `Esc` cancel, `1`/`2`/`3` switch pages). A PR's card says merge or send back, shows the criteria as a met/unmet checklist with evidence, a line from GitHub (CI checks, whether `VISION.md` was touched) that does not come from the PR, and, collapsed, what the PR does beyond its criteria. An action is recorded at once and held for ten seconds with an Undo, on an issue and on a PR alike; entail writes it to the case book and acts on GitHub (posts, closes or merges) when the window closes, and a restart completes it without acting twice. **Log** is every call on issues and PRs, newest first and paged by day, never trimmed, with the owner's call kept beside entail's; a call entail made alone can be overridden from it. **Repos** holds enrolling (with the issues already open offered as a separate click), confirm mode, the model and effort (one default, overridable per repo), the pins as read from their file, and the notice command as set (read only). The tab title carries the count. The board follows the system's light or dark theme until the toggle in its navbar picks one, which it remembers. The board is a React app built into `dist/board` by `npm run build`, and its source is in `board/`.

## Notices

When something starts waiting, entail can run one command the owner sets (`entail settings --notice '<command>'`, or `--notice none`; the board shows it but does not set it) with one line and a link appended as its last two arguments (`/bin/sh -c`, so `$1` and `$2`; on Windows `cmd.exe /d /s /c`, so `%~1` and `%~2` in a batch file), such as `entail: 1 question and 3 calls to confirm waiting on you http://127.0.0.1:4380/#/waiting`; never the question itself. The same command is told once when a repo's checks have been failing for 10 minutes (gh logged out, the repo gone or out of reach, the claude usage limit or a GitHub rate limit, with when it resets, or a model run erroring), as in `entail: owner/repo has been failing for 12 minutes: the pass: gh: not logged in`, and once when it works again (`entail: owner/repo is working again`), never on every poll and never twice for one run of failures, even across a restart. A PR whose landing judgment gave no call three times at one head is not failing and not recovered but stalled: it is told once per head (`entail: owner/repo stalled: PR #124 judged 3 times without an answer: <reason>; judged again on the next push`), and a new push clears it; meanwhile `entail status`, the repo's card on the board and a line atop the Waiting page say since when it fails and why. A failure changes no call and polling goes on. [`examples/`](../examples/) holds a command that appends the line to a file (`notice-to-file.sh`, or `notice-to-file.cmd` on Windows) and one that drops it into firstmate's inbox. By default there is none.

## Starting work

When a go acts (at once with confirm mode off; once the owner confirms it, answers go or overrides to go when it is on), entail can run one command the owner sets (`entail settings --start '<command>'`, or `--start none`; the board shows it but does not set it) with `/bin/sh -c` (`cmd.exe /d /s /c` on Windows) and the handoff on standard input as one line of JSON: the repo, the issue's number, URL and title, the call's reason, the criteria with their sources, and the `VISION.md` commit. Never on a no or an ask. Work is not started twice for an issue (a later go retries only after a start that failed); the log records that it started, by which command and with what exit status, and a command that fails is recorded and never holds up the call. entail depends on no executor: [`examples/start-to-file.sh`](../examples/start-to-file.sh) (or [`start-to-file.cmd`](../examples/start-to-file.cmd) on Windows) appends the handoff to a file. The PR that later closes the issue is judged at landing like any other. By default there is none.

## Suggesting work

On demand, entail suggests what should happen next in a repo from its vision and the product as it stands: **Suggest work** on the repo's card on the board, with the model and effort you pick (the repo's own by default), or `entail suggest owner/repo [--model <model>] [--effort <level>]`. One run reads `VISION.md`, the README and the tree at the default branch's head, the open issues and the suggestions filed before and since closed (so nothing filed is suggested again) and your past calls on the repo, and may take up to an hour on a big product. It files each suggestion as an ordinary issue labelled `entail:suggested` (a suggestion larger than one PR as one larger issue), which then gets the usual call like any new issue and keeps that label beside the call's; nothing goes on the board as a question. Each filed issue carries the run's hidden marker, so a restart never files one twice. The log shows each run with what it filed and what it considered and left out, with why; `entail suggest` prints the same. One run per repo at a time. Not part of this: scheduled suggestion runs, and suggestions shown on the board for you to pick from before anything is filed.

## The board's API

The board reads and writes through a small JSON API on the same address, the single path that records answers; the browser never talks to GitHub. It serves what is waiting and what is held in its undo window (`GET /api/waiting`), the log by day (`GET /api/log`), one call (`GET /api/calls/:id`), confirm, override, answer and undo (`POST /api/calls/:id/confirm|override|answer|undo`), the repos (`GET|POST /api/repos`, `PATCH|DELETE /api/repos/:owner/:name`, `POST /api/repos/:owner/:name/check|backlog|suggest`), the settings (`GET|PATCH /api/settings`), entail's status (`GET /api/status`) and live updates as server-sent events (`GET /api/events`). `src/api.ts` documents each. Each call it returns carries `kind`, "issue" or "pr"; a PR's call also carries `pr`, with the criteria checklist, the facts read from GitHub, the beyond-the-criteria sort and what entail did on the PR. It answers only on the loopback host, and takes writes only as JSON from no other origin.

## What entail keeps

Everything lives in entail's data directory (`~/.local/share/entail` on Linux, `~/Library/Application Support/entail` on macOS, `%LOCALAPPDATA%\entail` on Windows): one append-only log per repo in `log/github.com/<owner>/<name>.jsonl` (`log/gitlab.com/<group>/.../<name>.jsonl` for a GitLab project) holding every enrollment, setting, call on an issue or a PR (with what it read), owner's action, post and merge, from which everything shown is derived; the owner's case book in `cases/`; pins in `pins/<host>/<owner>/<name>.md`, one topic per line; which waiting items the owner was last told about, and which repos they were told are failing, in `notices.json`; the lock held by the running copy in `entail.lock`; and the settings, mirrors, cursors and operational log. With a backup remote set, the directory is also a git repository holding the records; see [backing up](#backing-up).

## The call on an issue

`judge` reads the issue and its comments, the repo's `VISION.md` and the repo itself at its default branch, the owner's pins for the repo, and the most relevant past cases, and answers go (with the criteria the PR must meet), no (with the reason) or ask (with the one question). A change that is large or hard to undo is always ask. The prompt is in `src/judgment.ts`.

## Backing up

entail's records (each repo's log, your case book, the settings and the pins) live only in its data directory, so losing that folder would lose every call, every confirmation and every case. To keep a copy elsewhere, name a git remote: `entail settings --backup <git remote url>`, such as a private repository on GitHub or GitLab (`git@github.com:you/entail-records.git`), a bare repository on another machine, or anything else your `git` can push to. Backup is off until you do, and nothing is pushed anywhere before that; `--backup none` turns it off again. entail pushes with your own `git` and whatever credentials it already uses for that remote (an SSH key, a credential helper, or a token you write into the URL yourself, which entail hides wherever it shows the remote); it holds no token of its own. The remote is set only from the command line; the board's Repos page shows it, read only, with when it last took a push.

With a remote set, the data directory is also a git repository (`.git` inside it; no file moves). After each pass, and so after each of your confirmations and answers acts, entail commits whatever changed among the records with a one-line message and pushes it to the remote's `main` branch. A `.gitignore` entail writes keeps everything else on this machine: the lock, the mirrors and checkouts, the cursors, `notices.json` and the operational log are never committed. Setting the remote while entail is not running pushes at once; a running entail pushes after its next pass. A push that cannot get through (the network, credentials, a remote not created yet) is recorded in the operational log and tried again after the next pass.

One machine writes to the remote; any other only restores from it. If the remote has moved on since entail last pushed, as when a second machine pushed to it or it was changed by hand, entail neither merges nor overwrites it: it keeps committing locally, stops pushing, writes `backup-stuck` with the reason to the operational log, and says so in `entail status`, `entail backup status` (which then exits 1) and on the board's Repos page. Sort the remote out by hand in the data directory with `git`, for example by pushing this machine's history over it with `git push --force origin main` once you are sure it is the one to keep, or by resetting the remote to the commit entail last pushed; entail resumes on the first push that fast-forwards the remote.

To restore on a new machine, install entail and, before it has run there, run `entail restore <git remote url>`. It clones the remote into the empty data directory, so the log, the case book, the settings and the pins come back where entail reads them, and prints what it restored. It refuses a data directory that holds anything. Restore clears the backup remote in the restored settings, so the restored copy does not push until you run `entail settings --backup <git remote url>`: one machine writes, a restored one only restores. Not part of this: several machines writing to one remote, scheduled backups, and encrypting the remote.

## The case book and replay

The case book is [`cases/`](../cases/) and the owner's own `cases/` in the data directory, whose cases win for the same issue: each case holds the issue as it stood (`issue.md`), `VISION.md` at the commit the call was made against (`vision.md`), and the owner's call with its reason and where that reason comes from (`call.md`). A landing case, marked `kind: landing` in its `call.md`, is the owner's merge or send-back on a PR: it adds the criteria the PR was judged against (`criteria.md`), the PR's title and description (`pr.md`) and the checks and changed files read from GitHub (`facts.json`), and names the judged head and base, from which the diff is read again. While the book holds eight cases or fewer, every case is precedent in the prompt; past that, the eight that are the same repo's and share the most words with the issue. `replay` runs at low effort unless `--effort` says otherwise and judges each one against its own vision and every other case of its kind, issue cases through the call on an issue and landing cases through the call on a PR, and prints the disagreements first. A change to how entail judges is checked by replaying the book.

## Development

You need Node 24 or newer and `git`.

```sh
npm ci
npm run typecheck
npm test        # node:test on the TypeScript sources, then the board's component tests (vitest)
npm run build   # compiles to dist/ and builds the board into dist/board
npm run board:dev  # the board with hot reload, against a running entail run on port 4380
```

The tests run no real model and reach no real forge: model runs are scripted, the GitHub and GitLab adapters are tested against recorded responses, and the board's pages are tested against a fake of its API.
