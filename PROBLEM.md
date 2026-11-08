# Problem statement

Recorded 2026-11-08, when the project restarted from an empty repo. Earlier vision, design notes and the board mockup remain in git history but are not the direction.

## The problem

- There is no durable record of what a product is and what has been said should be in it, so nothing can check work against it.
- Nothing defines which decisions need the owner, so everything comes back to the owner.
- Everything lives in chat, where it evaporates.
- Starting any work requires asking the orchestrator (firstmate) in chat every time; filing an issue or mentioning something starts nothing on its own.

The owner wants to own visions; implementation and decisions should be automatic.

**The bet:** models are intelligent enough already; what is missing is the engineering to use them.

## The vision of record

- What the product is, plus what the owner has said should be in it.
- Growing it can be manual, or automatic with notification. For starters it simply has to exist.
- Authoring the vision uses Kun Chen's [/vision skill](https://github.com/kunchenguid/vision) for now; entail does not rebuild vision authoring.

## The escalation rule

- Whatever the vision cannot settle comes back to the owner.
- That includes contradictions, and also new things the vision does not cover. Exaggerated example: adding a cartoon in the middle of the app's screen contradicts nothing, but nothing asked for it either.
- Tolerance scales with stakes:
  - A minor wrong call is acceptable and fixable later.
  - A large rework, or significant drift from the vision over time, must not happen unasked.

## The board

- Product decisions are surfaced on a board, not in chat.
- The board holds only product decisions, not work-management questions such as whether to start or pause some work.
- This split is part of why entail stands independent of firstmate.
- Firstmate can mechanically add custom instructions to every worker brief, which is a possible integration point.

## Acceptance criteria, at two points

- **At intake:** a ticket is checked against the vision and answered with what the PR must contain.
- **At landing:** the PR is checked for everything the ticket required, plus generic per-repo criteria (for example, whether the tests were run, depending on the repo).

## One product, built around the decider

1. **The what-needs-me decider.** Decides which decisions need the owner, judged against the vision. Autonomy can grow over time as the vision covers more and trust is earned. This could stand alone as a project idea.
2. **Vision-gated intake.** An issue or mention starts work automatically when the vision settles it; otherwise it lands on the board and nothing starts until answered.
3. **Criteria-checked landing.** Criteria set at intake are checked when the PR lands, together with the repo's generic checks.

## Scope and constraints

- Out of scope: large greenfield planning (the owner uses wayfinder for that).
- Personal use is acceptable.
- Local-first is acceptable.

## Open questions

- Do criteria need the owner's sign-off? (Suggested: only when writing them requires a product call.)
- Where do per-repo criteria come from: written per repo, or inferred from the repo and confirmed once?
- What happens when a PR misses a criterion: back to the worker, or to the owner?
- How much overlaps with no-mistakes, which already reviews, tests and gates merges?
- Does entail build on firstmate, stand alone, or both?
