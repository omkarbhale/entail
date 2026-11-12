# entail

entail is the owner's stand-in for product decisions on a repo. The test it applies to every change is one question: does this make the product better? The repo's `VISION.md` is the owner's word on what better means. Each issue gets one of three answers: go, with the few criteria an implementer would not guess; no, closed with the reason; or ask, which brings it to the owner. A PR merges when it solves its ticket's problem, meets what was asked and leaves the product better. Every call is recorded with its reason.

## Status

entail is being rebuilt. On 2026-11-12 it was started over in this repository around those two judgments, one per issue and one per PR; the first build made wrong calls, and [docs/restart-2026-11-12.md](docs/restart-2026-11-12.md) says why, what carried over and where the old tree is in history. The call on an issue works: entail watches enrolled repos, posts each call on its issue and takes the owner's confirmations, overrides and answers from the command line or a local API the board will use. Starting work from a go, the call on a PR, merging and notices are not built yet.

## Use

You need Node 24 or newer, `git`, `gh` logged in, and `claude` logged in.

```sh
npm ci && npm run build
node dist/cli.js enroll owner/repo             # watch a repo; it starts in confirm mode
node dist/cli.js run --dry-run                 # one pass that prints what it would post, and changes nothing
node dist/cli.js run                           # poll every minute, post each call, serve the board's API
node dist/cli.js waiting                       # the questions and calls to confirm waiting on you
node dist/cli.js confirm owner/repo#12         # or: override owner/repo#12 no "reason", answer owner/repo#12 go "answer"
node dist/cli.js calls owner/repo              # the log: every call and every answer, with its reason
node dist/cli.js judge owner/repo#123          # the call on one issue, printed; it posts nothing
node dist/cli.js replay                        # the case book through the judgment, agreement with the owner
```

`node dist/cli.js help` lists every command and option.

**Watching.** `run` polls each enrolled repo. Each issue filed after it was enrolled gets a call, and gets one again whenever its title or body is edited; a comment with a line starting `/entail` gets a call on its issue too, on any issue. Each call is one model run, Opus 5.5 at low effort unless the settings say otherwise (`entail settings`, for every repo or one), paid on the logged-in `claude`.

**Acting on the call.** The call is posted on the issue, opening with "Speaking from <owner>'s entail:". A go carries its reason and the criteria the PR must meet. A no carries its reason, quotes the vision lines it rests on, and closes the issue as not planned. An ask posts only a note that a question is waiting on the board; the question and its answer stay off GitHub. Every comment carries a hidden marker with the id of the log entry it speaks for, so a restart finds what it already posted and never posts it twice.

**Confirm mode.** A repo starts in confirm mode: entail posts its go or no but closes nothing until the owner confirms it. The owner can instead override a call with their own go or no and a reason, which is posted on the issue (reopening it for a go) and replaces the call. A question is answered with the owner's go or no and their words; on a go the judgment runs again with the answer as the owner's word, for the criteria. Every confirmation, override and answer is recorded under the owner's name and written as a case to the owner's case book. The owner turns confirm mode off per repo (`entail settings owner/repo --confirm off`) once entail stops being overridden; `entail repos` shows how often they agreed.

**The board's API.** `run` serves a small JSON API on `127.0.0.1:4380` for the board: what is waiting (`GET /api/waiting`), the log (`GET /api/log`), one call (`GET /api/calls/:id`), confirm, override and answer (`POST /api/calls/:id/confirm|override|answer`), the repos (`GET|POST /api/repos`, `PATCH|DELETE /api/repos/:owner/:name`) and the settings (`GET|PATCH /api/settings`). `src/api.ts` documents each. It answers only on the loopback host, and takes writes only as JSON from no other origin.

**What entail keeps.** Everything lives in entail's data directory (`~/.local/share/entail` on Linux, `~/Library/Application Support/entail` on macOS): one append-only log per repo in `log/github.com/<owner>/<name>.jsonl` holding every enrollment, setting, call (with the issue and vision it read), owner's action and post, from which everything shown is derived; the owner's case book in `cases/`; pins in `pins/<host>/<owner>/<name>.md`, one topic per line; and the settings, mirrors, cursors and operational log.

`judge` reads the issue and its comments, the repo's `VISION.md` and the repo itself at its default branch, the owner's pins for the repo, and the most relevant past cases, and answers go (with the criteria the PR must meet), no (with the reason) or ask (with the one question). A change that is large or hard to undo is always ask. The prompt is in `src/judgment.ts`.

The case book is [`cases/`](cases/) and the owner's own `cases/` in the data directory, whose cases win for the same issue: each case holds the issue as it stood (`issue.md`), `VISION.md` at the commit the call was made against (`vision.md`), and the owner's call with its reason and where that reason comes from (`call.md`). While the book holds eight cases or fewer, every case is precedent in the prompt; past that, the eight that are the same repo's and share the most words with the issue. `replay` judges each one against its own vision and every other case, and prints the disagreements first. A change to how entail judges is checked by replaying the book.

## Why

Agents can implement. What is missing is a durable record of what the product is and someone to make the product call on each ticket and each PR the way the owner would, so that today every decision comes back to the owner in chat and evaporates there. entail never writes code, pushes or opens PRs; on the forge it only comments, labels, closes and merges. More in [PROBLEM.md](PROBLEM.md) and [VISION.md](VISION.md).

## Development

You need Node 24 or newer and `git`.

```sh
npm ci
npm run typecheck
npm test        # node:test, running the TypeScript sources directly
npm run build   # compiles to dist/
```

The tests run no real model and reach no real forge: model runs are scripted, and the GitHub adapter is tested against recorded responses.
