# Dev Orchestrator - Problem & Direction

*Entail's vision artifact: the handoff that seeds the project, written
2026-09-20. Preserved as stated. Entail has no artifact format yet, so this is
a plain document.*

## The problem

Programming with LLM assistance spans several distinct verticals: product
decisions, product vision, software architecture, high-level software
decisions, UI design, development, testing, validation. These are different
kinds of thinking, with different inputs and different outputs.

Right now, when I sit in a chat and type things out, all of those pillars get
mixed into one stream. Two things go wrong.

Context gets lost inside a single session. If I explain the product vision
early on, it's gone by the time we're discussing classes and interfaces.
Nothing is holding it. The conversation has moved down a level and the upstream
reasoning is no longer in play.

Nothing persists across sessions. Whatever was decided, and whatever reasoning
produced it, lives only in scrollback.

The practical consequence: with no separation, I have to explain the thing and
have it build the thing in the same chat, every time.

The goal is to increase the leverage I get from LLMs without paying for it in
quality.

## The concept

An orchestrator that keeps the verticals separate and manages the backlog
across them.

Each vertical owns a persistent artifact. The orchestrator hands the right
slice downward, so that when I'm working at the code level the architectural
constraints are already present without my re-stating them, and the
architecture itself was derived from a vision that still exists somewhere I can
point at.

Separation is the mechanism; persistence is what makes the separation worth
anything. A layer that doesn't outlive the session isn't a layer, it's just a
paragraph earlier in the chat.

The backlog sits across all of it. Not per-feature task lists, but a view of
what should be built next given what the vision and architecture say.

## Delegation as a dial

This is the part I care most about, and I think it's the part that's actually
mine.

Once the verticals are separate, I can offload any amount of decisions from any
vertical, as my choice. All of it, some of it, none of it. If my problem
statement and solution are already clear, I can hand off architecture and UX
entirely and never look at them. Not everything has to go through me.

Right now there's no way to express that. Every decision either passes through
me in the chat or gets improvised by the model from whatever happens to be in
scrollback.

The two halves depend on each other. Separation is what makes delegation safe:
offloading architecture doesn't mean "do whatever," it means "derive it from
the vision I did specify." Without a persistent upstream artifact, offloading
is just improvisation. With one, it's derivation.

## Prior art

The category exists and is called spec-driven development. Specifications, not
code, are the source of truth. Much of what I described is already built.

| Tool | What it is | Overlap |
| --- | --- | --- |
| BMAD-METHOD | Agent personas per role (Analyst, PM, Architect, PO, Dev, QA, UX). Planning phase produces brief, PRD, architecture doc, then shards them into story files carrying constraints and rationale. | Closest to my framing. Essentially the vertical separation, already built. |
| GitHub Spec Kit | Python CLI, 30+ agents. Five stages: constitution, specify, plan, tasks, implement. A Constitution Check gate blocks plans that violate stated principles. | The constitution is the persistent-vision enforcement I wanted. |
| OpenSpec | Three-phase state machine. specs/ holds current truth, changes/ holds proposals, archiving merges them back. | Best persistence model. Brownfield-first. |
| Kiro (AWS) | Agentic IDE with steering files. | Vendor-locked, metered. |

What none of them do: treat delegation depth as a concept. BMAD relays through
the human at every handoff, Kiro gates all three phases with approval, Spec Kit
applies its constitution check uniformly. They each assume one posture toward
the whole pipeline. You can fake partial delegation by not reading the output,
but that isn't the system knowing a layer is delegated and behaving
accordingly.

Known problems in the category: spec drift over time, ceremony overhead on
small changes, and weak codebase alignment on large repos.

Comparison repo worth reading: spec-compare.

## Constraints I'm accepting

These are acceptable conditions for a first version, not what the thing is for.
Nothing in the vision above depends on either of them.

Personal use is acceptable. It doesn't need other users to be worth having. No
auth, keys, tenancy or billing, and anything that slows down core problem
solving stays out.

Local-first is acceptable. Artifacts as files in the repo, diffable and
reviewable like everything else. Nothing hosted, nothing to sync.

## Open questions

Unresolved. Recorded so they don't get re-derived later, with my position noted
where I have one.

**Decision leakage.** What I can offload downward is bounded by how tightly I
specified upward. If the vision is loose and I delegate architecture, the
architect will make product decisions while presenting them as architectural
ones, and I won't notice because I chose not to look. My position: a vertical
that depends on another should flag rather than improvise. If what it needs
from upstream isn't there, it says so instead of filling the gap silently.
That's the default behaviour I want. Still open is how the system detects this.
Recognising that an upstream artifact failed to determine a decision is harder
than recognising that it was contradicted.

**Review debt.** Delegating creates an auditing problem after the fact.
Something's wrong in the code and I can't tell whether it's a bad
implementation of good architecture or a faithful implementation of bad
architecture. Implies delegated output needs a different shape than reviewed
output: enumerated decisions with rationale, not a long document.

**Granularity of the dial.** Probably not per-vertical in practice. More likely
delegate a vertical by default and pin specific decisions I care about.
