# Design record — 2026-09-20

Source: a design conversation held on 2026-09-20. Recorded here so it persists
instead of living only in chat scrollback.

What this record does **not** do: it does not resolve anything the conversation
left open, and it does not tidy a ruling into something more decided than it
was. Where a ruling is ambiguous, the ruling is recorded as stated and the
ambiguity is logged in [`2026-09-20-open-questions.md`](2026-09-20-open-questions.md).
Where a ruling rejected or corrected the critique that prompted it, both the
critique and the correction are kept, because a conclusion without its
rationale cannot be audited. That is the recorder's own choice.

The layout below is ad hoc formatting for this document only. It is not
Entail's decision-record format. See [`README.md`](README.md). The text under
the bold labels below is the captain's; the labels themselves are the
recorder's classification of what the ruling did.

---

## 1. The flow

Stated as the intended shape of the pipeline.

- Somebody arrives and describes some task, feature, activity, or a product to
  build. That goes into a pipeline and follows it.
- First step: check the product vision — conflicts, missing, scope mismatch.
  (Later revised by the rulings on point 2 and point 7 below.)
- If the vision is empty, start a small grill on the vision.
- Once that is done, check decisions — the same things: check missing or
  mismatch, follow existing. (Later revised by the ruling on point 2 below.)
- During the pipeline there are stricter briefs, in some format, which check
  whether the thing already exists. If a decision worth asking for this task
  already exists, do not ask it again.
- And so on, until the final pull request.
- Some of the runs are not mandatory: testing, accessibility validation, UX
  validation, performance validation, and so on.

Beyond the artifacts themselves, the pipeline spawns runs: development,
testing, performance validation, UX design, UX validation, and quality concerns
such as accessibility. Each iteration gets briefs.

An unresolved question raised at the same time as the flow: whether those briefs
are built and handed to the developer or kept separate, because the developer
should not be overloaded. (Carried to the open questions document.)

For vision, decisions, and architecture — at least the early layers — the user
wants some say in what is going on.

**Entail is not a set of skills. It is an orchestrator.**

---

## 2. The eight points and the rulings on them

### Point 1 — Amend and execute are the same pipeline

**Critique.** Grilling the vision changes a standing artifact, while building a
feature reads one. The flow as described does the first inside the second. This
bites when two tasks are in flight, one amends the vision, and the other is
already derived from the old version with nothing marking it stale.

**Ruling.** Correct. They should be two different operations.

**Also established by the same ruling.** Along the same lines: when a task goes
through an artifact step, there can be several checks that can be defined —
what is missing, what is conflicting, whether the artifact is sufficient to
allow the task to go forward, or whether to block it at that step.

**Status of the critique.** Accepted as stated.

---

### Point 2 — The upstream check detects the wrong failure

**Critique.** Conflicts and missing are contradiction and emptiness. Both are
easy, and both are safe precisely because you notice them. Under-determination
is the failure that motivated the product, and this check walks past it.

**Ruling.** Correct, and this is related to point 1. The check should be
performed on whether the artifact satisfies *this task*, not on the whole scope
of the entire artifact in question. Every pipeline step, for now, only checks
whether upstream is sufficient for this task.

**Status of the critique.** Accepted as stated.

Note the qualifier "for now" is the captain's, and is recorded rather than
smoothed away.

---

### Point 3 — The grill sits where users will bypass it

**Critique.** A vision interview triggered by a small change gets abandoned, so
small changes stop going through Entail, and the artifacts rot on everything
small.

**Ruling.** This misread the original point.

**Correction supplied by the ruling.** Some of these decisions are per task and
some settings are per project. The user can decide that for one project they
want a validation pipeline, or do not want one. That is not decided per task,
per feature, or per execution.

**Status of the critique.** Rejected as a misreading. Both the critique and the
correction are kept here deliberately: the critique is not recorded as agreed.

---

### Point 4 — "Already decided" matching is treated as free

**Critique.** Matching a new question against an existing decision is fuzzy. A
miss re-asks harmlessly, but a wrong match applies a decision to a case it never
covered, silently, and it looks like derivation.

**Ruling.** Correct. Bias toward re-asking.

**Also established, separately, at this point in the conversation** (stated as
something that should have been said sooner, not as a consequence of point 4):

> Entail is also to have a user interface showing all tasks and in-flight
> features and their status, where they can be sent to the next stage or sent
> automatically, stopping only when they have something to raise or the user is
> needed somewhere. This allows managing multiple things asynchronously, which
> is one of the main points of Entail. The board is wanted and is part of the
> product.

**Status of the critique.** Accepted as stated.

---

### Point 5 — The user picks the validations

**Critique.** At submission time the user is thinking about the change, not
about which validations it needs, so they will under-select precisely when it
matters.

**Ruling.** As in point 3 — some of these are project-specific settings and not
all of them are task-specific.

**Status of the critique.** Answered by the same correction as point 3, rather
than accepted on its own terms.

---

### Point 6 — There is no loopback

**Critique.** Development hits a case architecture does not determine, or a
validation contradicts a product decision, and the ladder has no route back, so
people hand-fix and the artifacts rot.

**Ruling.** Right to question it. It will be a blocker handled by the
orchestration.

**Reasoning given with the ruling.**

- If architecture was derived from vision and product decisions, and there was
  no human in the loop for that task's architecture, routing back to the
  architecture layer seems wise — because the architecture will produce
  architecture that aligns with the decisions and the vision anyway. If the
  first pass was allowed to go forward, there is no harm in allowing the second
  pass to go forward as well.
- Give a few tries — two or three, or maybe one — for the layers to clarify
  between themselves. If that does not resolve it, move upstream.
- Bounding what the layers may settle is needed: interpreting what is already
  upstream can be looped easily, but nothing in that can be changed, and if it
  really is a blocker then it will be raised.
- Not every scenario should be looped. If it is extremely clear that something
  needs a decision, that is routed back as a blocker.

**A later statement bears on this.** See
[`2026-09-20-build-philosophy.md`](2026-09-20-build-philosophy.md).

**Also established by the same ruling — per-task vs project artifacts.**

- Nothing in terms of clarification will change the product vision, but
  architecture might.
- So there is a distinction between per-task artifacts and project artifacts.
- A task artifact could be architecture regarding just that one task, which can
  be changed and clarified. Those per-task ones can be volatile.
- The main project artifacts should always require a decision.

**Status of the critique.** Accepted as a real gap; answered with the loopback
design above.

---

### Point 7 — Scope is doing two jobs

**Critique.** Scope was listed as a check alongside conflicts and missing, and
separately wondered about as its own layer.

**Ruling.** Correct. Scope belongs in the decisions phase rather than the
vision phase.

**Reasoning given with the ruling.** The vision is often simple to understand,
and scope is ultimately the decision taken by the user or project maintainer
about what is in scope versus what is not, which may be bound to change.

**Instruction attached to the ruling.** Do not engineer around scope. For now,
handle it as just another product decision.

**Status of the critique.** Accepted as stated.

---

### Point 8 — Layer purity

**Critique.** Each layer should contain only what that layer is supposed to
contain. If the user starts talking about architecture in the decisions phase,
or about product vision in the decisions layer, or about how validation should
be done in the decisions layer, Entail should stop them.

**Ruling.** It should **not** hard-block.

**Correction supplied by the ruling.**

- There should be guardrails from the Entail side about deciding what should go
  where.
- Since the models used are intelligent regardless, the routing will mostly be
  accurate.
- Showing in the interface where something is being routed to is reasonable,
  but is a far implementation detail and not the core problem.
- If something is working, use it rather than diving deep into where a decision
  is getting parked.

**A later statement bears on this.** See
[`2026-09-20-build-philosophy.md`](2026-09-20-build-philosophy.md).

**Status of the critique.** The premise (layers should hold what belongs to
them) stands; the proposed remedy (stop the user) is overridden. Both are kept.

---

## 3. Promotion of per-task artifacts

A per-task artifact gets promoted automatically when a task cannot be completed
because of inconsistencies in the existing pipeline.

When that happens:

- the task is simply blocked, and
- the orchestrator asks the user to go into the right layer, and asks them what
  to do.

---

## 4. Constraints already accepted

- **Personal use is acceptable.** No auth, keys, tenancy or billing.
- **Local-first is acceptable.** Artifacts as files in the repo, diffable and
  reviewable. Nothing hosted and nothing to sync.
- **Entail is not yet bootstrapped onto itself.** Build Entail first, and
  bootstrap when it is something worth using.
