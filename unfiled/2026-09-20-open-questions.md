# Open questions as of 2026-09-20

Recorded so they are not silently re-derived by whoever builds next.

Every question here is still open, and nothing here is closed. Some entries
carry a later narrowing, recorded as such under the entry; a narrowing is not
an answer. Apart from those, no position has been taken on anything here. Where
an input exists that argues for one answer, that input is named, but naming it
is not adopting it. Recording a position the captain did not take is the
failure this product exists to prevent. Nothing is described as deferred unless
a ruling deferred it: a question nobody has answered and a question deliberately
parked need different handling later, and collapsing the two is that same
failure.

Entries are grouped by where they came from. Sections A and B are what the
2026-09-20 conversation itself left open. Section C is what the prior-art
investigation and the repository owner flagged as open; those questions were
not raised in that conversation, and the investigation has ruled on nothing —
they are listed because nobody has answered them.

Companion to [`2026-09-20-pipeline-design-record.md`](2026-09-20-pipeline-design-record.md).

---

## A. Left open by the 2026-09-20 conversation

### A1. The vertical set

How many layers own a persistent artifact, and whether that set is fixed by
Entail or chosen per project.

The design record names vision, decisions and architecture as layers where the
user wants some say, and names development, testing, performance validation, UX
design, UX validation and accessibility as runs the pipeline spawns. Which of
those own a persistent artifact is not settled by that naming.

**A possible contradiction with the standing vision artifact, flagged rather
than settled.** [`VISION.md`](../VISION.md) line 41 states "Each vertical owns
a persistent artifact", and its vertical list (lines 14-16) includes
development, testing and validation — the same items the 2026-09-20
conversation places among the runs the pipeline spawns "beyond the artifacts
themselves". That placement reads as though those runs own no artifact, which
is what line 41 denies of any vertical. The conversation did not say it; the
reading is the recorder's, and whether it is what the conversation meant is
part of the open call above.

### A2. Briefs: handed to the developer, or kept separate

Raised in the same breath as the flow and not ruled on: whether the per-
iteration briefs are built and handed to the developer or kept separate,
because the developer should not be overloaded.

---

## B. Ambiguities in the 2026-09-20 rulings

These are flagged, not resolved. Each is recorded as stated in the design
record; this section only marks where a builder will find the ruling
under-determined.

### B1. Which settings are per project and which are per task

Points 3 and 5 both turn on the distinction between per-project settings and
per-task decisions, and give one example ("the user can decide that for one
project they want a validation pipeline, or do not want one"). The full
partition — which settings sit on which side — is not enumerated.

### B2. The loopback retry count

Point 6 gives it as "a few tries, two or three, or maybe one". The number is
left open by the ruling itself, as is whether it is fixed, configurable, or
per-layer.

**Narrowed, not closed.**
[`2026-09-20-build-philosophy.md`](2026-09-20-build-philosophy.md) records a
later refinement stating a condition in place of a count — retry when
interpretation is the problem, route upstream when it is not — and stating that
clarification retries are not dropped; the number, and whether there is one at
all, is still open.

### B3. The bound on what layers may settle between themselves

Point 6 states that bounding is needed, and states the principle: interpreting
what is already upstream can be looped easily, but nothing in that can be
changed, and if it really is a blocker it will be raised. How that bound is
expressed or enforced is not specified.

### B4. What makes something "extremely clear" enough to route back as a blocker

Point 6 distinguishes cases that should loop from cases where "it is extremely
clear that something needs a decision" and so go back as a blocker
immediately. The test that separates them is not given.

**Narrowed, not closed.**
[`2026-09-20-build-philosophy.md`](2026-09-20-build-philosophy.md) records a
later refinement naming interpretation as what separates them — retry when
interpretation is the problem, route upstream when it is not — but how that is
told apart in a given case is still not given.

### B5. What the layer-purity guardrails are

Point 8 rules out hard-blocking and calls for "guardrails from the Entail side
about deciding what should go where", relying in part on the models being
intelligent regardless. What a guardrail is, mechanically, is not specified,
and the ruling explicitly defers the interface side of it as a far
implementation detail.

**Narrowed, not closed.**
[`2026-09-20-build-philosophy.md`](2026-09-20-build-philosophy.md) records a
later refinement stating that layer purity is done automatically, by the model,
using instructions for deciding that Entail supplies, and is not separate
machinery; what those instructions say, and the interface side, are still
open.

### B6. Which artifacts are per-task and which are project artifacts

Point 6 establishes the distinction, gives per-task architecture as the
example, and states that per-task artifacts can be volatile while the main
project artifacts should always require a decision. The membership of each set
beyond that example is not settled. Related: A1.

### B7. What counts as "inconsistencies in the existing pipeline" for promotion

The promotion rule triggers when a task cannot be completed because of
inconsistencies in the existing pipeline. What qualifies is not defined.

### B8. The word "promoted" in the promotion rule

The rule states that a per-task artifact gets promoted automatically, and in
the same breath that the task is simply blocked and the orchestrator asks the
user to go into the right layer and asks them what to do. Whether "promoted
automatically" names an automatic change to a project artifact, or names the
automatic escalation of the question to the user, is not disambiguated by the
ruling. Recorded as stated rather than resolved.

### B9. The scope of "for now"

Points 2 and 7 both carry a "for now" qualifier — every pipeline step checking
only whether upstream is sufficient for this task, and scope being handled as
just another product decision. What would later change either is not stated.

---

## C. Flagged outside the 2026-09-20 conversation

These were not raised in that conversation. They are open questions the
prior-art investigation
([`prior-art-investigation-2026-09-20.md`](prior-art-investigation-2026-09-20.md),
§9) named as undetermined, carried forward here by the repository owner. That
report has ruled on nothing; listing its questions is not adopting anything it
recommends.

### C1. Entail's artifact format

Enumerated decision records with upstream citations, prose documents, or a
hybrid. That option set is the investigation's own (§11), not the captain's.

**A later ruling, bearing undetermined.**
[`2026-09-20-build-philosophy.md`](2026-09-20-build-philosophy.md) records the
captain ruling that citations stay. Whether that ruling narrows the option set
above is undetermined, and is part of this same open call.

**Unanswered, not deferred.** The question was put to the captain; he answered
a different and narrower one — how to store this record: "You can write it in
any format you like - this is just for persistence in Entail for now". That
settles the format of this folder. Entail's artifact format as a product
decision was never addressed, and no ruling deferred it.

Everything in this folder — including the shape of the design record next to
this file — is ad hoc prose formatting adopted to get the material written
down, and constitutes no part of an answer here.

The investigation argues this is the load-bearing decision and recommends
enumerated decision records each citing an upstream anchor (§9.1, §4.2, §11).
That report decides nothing; no ruling has been made on its recommendation.

### C2. Where the orchestrator runs

A CLI, a library, a long-running process, a skill inside an agent. Nothing so
far constrains this.

Two statements bear on it without settling it: "Entail is not a set of skills,
it is an orchestrator", and the board (a user interface showing all tasks and
in-flight features and their status) being part of the product.

### C3. Delegation dial semantics

What it means to flip an already-written artifact from authored to derived, and
whether pins can cover topics that have no decision yet.

### C4. Whether the backlog view is authored or derived

Undecided.

### C5. Success criterion

No success criterion has been stated for Entail as a whole.
