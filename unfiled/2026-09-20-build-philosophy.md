# Build philosophy — 2026-09-20

Source: the same design conversation of 2026-09-20 recorded in
[`2026-09-20-pipeline-design-record.md`](2026-09-20-pipeline-design-record.md),
plus what the captain stated after it. Recorded here so it persists instead of
living only in chat scrollback.

What this record does **not** do. On the captain's instruction, this document
records the settled position only; the recorder's earlier misreadings of it are
not kept alongside it. That instruction is scoped to this document. It is not a
general rule for the repository, and the eight-point design record keeps its
critiques beside its rulings, unchanged.

Where the captain ruled without explaining, the ruling is recorded alone.
Nothing below is given a rationale he did not give. Where the text states a
reading rather than something he said, it says so.

The layout below is ad hoc formatting for this document only. It is not Entail's
decision-record format; no such format has been chosen. See
[`README.md`](README.md).

---

## 1. The principle

Stated by the captain as how Entail is to be built, at least at the start.

> Keep it really really simple, at least at the start. Each and every feature we
> should add — not saying it should be 100% correct, but instead of adding 100
> features that look really really good when you look at them, rather have
> something simple that just works.

What that admits, as he enumerated it: a few layers in the pipeline, a lot of
markdown briefs for the agents, backlog and tracker management, the raising of
decisions, and looping. A layer may be incomplete and the briefs may need
tweaking; that is a good starting point.

**Reasoning given with the principle.** The main point is that instead of adding
fancy features, or going into territory that skips or sidelines the core problem
Entail is trying to solve, that should be deferred for later.

**The qualifier the captain attached.** Simple, not less amount and not less
difficult.

**The two examples he gave, from different contexts.**

- He would not engineer a system prompt when the model writes garbage.
- He would not care about providing tools to the model that save user
  preferences or memory when the model takes ten-plus minutes on a simple
  ten-second task.

---

## 2. Statements the captain made after the design conversation

### 2.1 Layer purity is done by the model, not by separate machinery

Layer purity is done automatically, by the model, using instructions for
deciding that Entail supplies. It is not separate machinery.

Bears on
[point 8](2026-09-20-pipeline-design-record.md#point-8--layer-purity) of the
design record.

### 2.2 Clarification retries are not dropped, and gain a condition

Clarification retries are not dropped. Retry when interpretation is the problem,
and route upstream when it is not.

Whether a count also remains, and what it is, is not stated here. Bears on
[point 6](2026-09-20-pipeline-design-record.md#point-6--there-is-no-loopback) of
the design record, and on
[`2026-09-20-open-questions.md`](2026-09-20-open-questions.md) B2.

### 2.3 Citations stay

Citations stay.

Recorded as stated; "stay" is the whole ruling. See
[`2026-09-20-open-questions.md`](2026-09-20-open-questions.md) C1.

---

## 3. Raised, and not settled

**Separation between what the user gave and what a layer produced. (Maybe.)**

The captain raised this as a direction and did not rule on it. Recorded in his
own hedge:

> There should probably be separation between what the user gave and what a
> layer produced, because the entire architecture could supposedly be up for
> change if a human never asked for it or approved it. Maybe.

The "Maybe" is his and is kept. This is direction, not a ruling, and nothing
downstream should treat it as decided.

---

## 4. Evidence for the premise

The captain stated that no proof step is needed for whether separation produces
better output. That is already known to work.

The evidence he gave: it has been run with two layers, a writer and a critic,
looped a few times, and the output was better because the critic never drifted
from what was asked of it.

---

## 5. Standing assumption, not previously written down

**Each layer gets everything before it, along with its brief.**

This is the captain's position. It is not derived from anything in this
repository, and it is not presented as following from the design record or from
the handoff.

He states that it was always true and was always assumed. It had not been
stated in the handoff or in the design record, and it is written down here for
the first time.

Why that matters in practice, as the recorder reads it: a builder reading only
the handoff ([`VISION.md`](../VISION.md)) and the design record could have
implemented adjacent-layer handoff — each layer receiving only its immediate
predecessor's output — and nothing in either document would have contradicted
them. That reading is the recorder's; the captain did not state it.
