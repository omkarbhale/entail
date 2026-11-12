# entail

entail is the owner's stand-in for product decisions on a repo. The test it applies to every change is one question: does this make the product better? The repo's `VISION.md` is the owner's word on what better means. Each issue gets one of three answers: go, with the few criteria an implementer would not guess; no, closed with the reason; or ask, which brings it to the owner. A PR merges when it solves its ticket's problem, meets what was asked and leaves the product better. Every call is recorded with its reason.

## Status

entail is being rebuilt. On 2026-11-12 it was started over in this repository around those two judgments, one per issue and one per PR; the first build made wrong calls, and [docs/restart-2026-11-12.md](docs/restart-2026-11-12.md) says why, what carried over and where the old tree is in history. The call on an issue works from the command line; it only prints the call and posts nothing yet.

## Use

You need Node 24 or newer, `git`, `gh` logged in, and `claude` logged in.

```sh
npm ci && npm run build
node dist/cli.js judge owner/repo#123     # go, no or ask on one issue, with the reason
node dist/cli.js replay                   # the case book through the judgment, agreement with the owner
```

Both run Opus 5.5 at low effort unless `--model` or `--effort` says otherwise; each call is one model run, paid on the logged-in `claude`.

`judge` reads the issue and its comments, the repo's `VISION.md` and the repo itself at its default branch, the owner's pins for the repo, and the most relevant past cases, and answers go (with the criteria the PR must meet), no (with the reason) or ask (with the one question). A change that is large or hard to undo is always ask. The prompt is in `src/judgment.ts`.

Pins are topics the owner wants brought to them, kept on the owner's machine in `pins/<host>/<owner>/<name>.md` under entail's data directory (`~/.local/share/entail` on Linux, `~/Library/Application Support/entail` on macOS), one topic per line.

The case book is [`cases/`](cases/): each case holds the issue as it stood (`issue.md`), `VISION.md` at the commit the call was made against (`vision.md`), and the owner's call with its reason and where that reason comes from (`call.md`). While the book holds eight cases or fewer, every case is precedent in the prompt; past that, the eight that are the same repo's and share the most words with the issue. `replay` judges each one against its own vision and every other case, and prints the disagreements first. A change to how entail judges is checked by replaying the book.

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
