# Problem statement

Recorded 2026-11-08, when the project restarted from an empty repo. Earlier vision, design notes and the board mockup remain in git history but are not the direction. Commit f336238 is the last tree before the delete.

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
- Every line records its origin: stated by the owner, or proposed by an agent and approved by the owner. Otherwise an agent's proposal can later read as the owner's word, which is silent drift.
- Authoring the vision uses Kun Chen's [/vision skill](https://github.com/kunchenguid/vision) for now; entail does not rebuild vision authoring.

## The escalation rule

- Whatever the vision cannot settle comes back to the owner.
- That includes contradictions, and also new things the vision does not cover. Exaggerated example: adding a cartoon in the middle of the app's screen contradicts nothing, but nothing asked for it either.
- The vision does not settle a call when two or more defensible readings lead to observably different outcomes and nothing in the vision chooses between them.
  - Sufficiency is judged for this ticket, not for the whole vision.
  - When unsure, ask: a wrong "already settled" silently applies a ruling to a case it never covered, while an extra question is cheap.
  - Choices a model does not notice it is making cannot be caught reliably; the aim is to make them visible and attributable afterwards.
- Every "the vision settles this" cites the vision passage relied on. A vision change flags in-flight work that relied on the old text.
- Pins: the owner can say ahead of time that anything touching some topic always comes to them, even where no decision exists yet.
- A short log records each call settled automatically, with its reason, so it can be audited later.
- Tolerance scales with stakes:
  - A minor wrong call is acceptable and fixable later.
  - A large rework, or significant drift from the vision over time, must not happen unasked.

## The board

- Product decisions are surfaced on a board, not in chat.
- The board holds only product decisions, not work-management questions such as whether to start or pause some work.
- Its value over chat is structure. Chat is unorganized: delegation, progress, questions and answers all run together. Each item instead carries what the ticket or task was, what happened, and why it was raised.
- An answer on the board records that the owner gave it, through a single path that records answers.
- How the owner learns an item is waiting is open.
- This split is part of why entail stands independent of firstmate.
- Firstmate can mechanically add custom instructions to every worker brief, which is a possible integration point.

## Acceptance criteria, at two points

- **At intake:** a ticket is checked against the vision and answered with what the PR must contain.
- **At landing:** the PR is checked for everything the ticket required, plus generic per-repo criteria (for example, whether the tests were run, depending on the repo).

- Checks the model grades on itself can be bypassed (a self-graded check, or a tool that accepted an empty vision as done). Prefer mechanical checks where a criterion allows, and always persist the verdict and its reason.
- Generic per-repo criteria are a per-repo setting fixed once, not asked per ticket. A ticket the vision plainly settles takes a zero-ceremony path.

## One product, built around the decider

1. **The what-needs-me decider.** Decides which decisions need the owner, judged against the vision. Autonomy can grow over time as the vision covers more and trust is earned. This could stand alone as a project idea.
   - Candidate first milestone and success test: a small vision and a handful of tickets, some settled by it, some it is silent on, some contradicting it. The decider passes when it starts the first and escalates the others without inventing rulings.
2. **Vision-gated intake.** An issue or mention starts work automatically when the vision settles it; otherwise it lands on the board and nothing starts until answered.
3. **Criteria-checked landing.** Criteria set at intake are checked when the PR lands, together with the repo's generic checks.

## Scope and constraints

- Out of scope: large greenfield planning (the owner uses wayfinder for that).
- Personal use is acceptable.
- Local-first is acceptable.

## Open questions

- Do criteria need the owner's sign-off? (Suggested: only when writing them requires a product call.)
- Where do per-repo criteria come from: written per repo, or inferred from the repo and confirmed once? (Proposed: a per-repo setting fixed once, not asked per ticket.)
- What happens when a PR misses a criterion: back to the worker, or to the owner? (Proposed: route by where the root cause sits. The work is wrong: back to the worker. The criterion is wrong or unclear: re-derived from the vision. The vision is silent: to the owner. A small bounded retry count applies before escalating.)
- How much overlaps with no-mistakes, which already reviews, tests and gates merges?
- Does entail build on firstmate, stand alone, or both?
