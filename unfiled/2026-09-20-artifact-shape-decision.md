# Artifact shape — 2026-09-20

**Authority: derived.** The captain delegated this call in these words:

> You decide artifact shape ;) also note that artifact shape is derived

**Party who made it: the recorder.** It is not the captain's decision, and the
captain named its authority deliberately.

The layout below — its headings, its numbering, its ordering — is ad hoc
formatting invented to get this written down, exactly as
[`README.md`](README.md) says of this folder. Section 1.3.1 asks what Entail's
concrete syntax should be, and this document had to be written in some shape
before that question had an answer. The shape used here is that ad hoc shape
and is no part of an answer to 1.3.1.

---

## 1. The decision

Entail's artifacts are enumerated decision records, each carrying the upstream
decision that determined it. Not prose documents, and not a hybrid of the two.

### 1.1 What determined it

The captain ruled:

> Citations: They stay.

That ruling is recorded at
[`2026-09-20-build-philosophy.md` §2.3](2026-09-20-build-philosophy.md#23-citations-stay).
"Stay" is the whole of it; no reasoning was given with it and none is attached
to it here.

The reasoning below is the recorder's.

A citation needs a stable, addressable anchor to point at. Prose has none, so
prose cannot carry one. The prose option falls to the captain's ruling rather
than to anyone's preference.

The hybrid option — a prose body with a structured decision index — fails that
same ruling in part. Its prose half carries no anchors, so half of the artifact
sits outside the citation graph. A citation graph with holes checks only the
part that was already structured, which was never the part at risk.

### 1.2 Supporting evidence — the recorder's, not the captain's

Sixteen review rounds ran on this repository's own records on 2026-09-20. In
the recorder's reading of those rounds, nearly every defect found took one of
two shapes: a fact stated in two places drifting apart, or a relationship
between two things characterised rather than pointed at. Both are structurally
impossible when the unit is a decision citing its anchor. Both occurred
repeatedly inside documents written expressly to prevent them.

The captain did not state this evidence and has not ruled on it.

### 1.3 Unresolved parts of this decision

The captain directed that these be recorded as open underneath the decision
itself. Nothing upstream selects between the alternatives in any of them. No
position is taken on any of them below, and nothing in section 1 above should
be read as taking one.

#### 1.3.1 The concrete syntax and field names

Open. Nothing upstream selects a syntax or a field vocabulary.

#### 1.3.2 One record per file, or many records to a file

Open.

#### 1.3.3 How an anchor is addressed — an id, a content hash, or both

Open, and carrying weight beyond syntax. A content hash is what would make
staleness detection mechanical: a changed upstream anchor would mark every
dependent decision stale with no model involved. Nothing stated so far reaches
that question.

#### 1.3.4 Whether an artifact may carry narrative framing around its records, or is records only

Open.

### 1.4 Consequence of the authority the captain named

Because the decision is derived rather than his, nothing in it is owed
protection. If the vision or the captain's rulings move, it is regenerated
wholesale rather than patched.
