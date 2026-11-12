# entail

entail is the owner's stand-in for product decisions on a repo. The test it applies to every change is one question: does this make the product better? The repo's `VISION.md` is the owner's word on what better means. Each issue gets one of three answers: go, with the few criteria an implementer would not guess; no, closed with the reason; or ask, which brings it to the owner. A PR merges when it solves its ticket's problem, meets what was asked and leaves the product better. Every call is recorded with its reason.

## Status

entail is being rebuilt. On 2026-11-12 it was started over in this repository around those two judgments, one per issue and one per PR; the first build made wrong calls, and [docs/restart-2026-11-12.md](docs/restart-2026-11-12.md) says why, what carried over and where the old tree is in history. There is no runnable command yet: the tree holds the modules the rebuild starts from, with their tests.

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
