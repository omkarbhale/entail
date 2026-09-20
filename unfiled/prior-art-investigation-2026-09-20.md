> **Why this file is in the repository.**
>
> [`VISION.md`](../VISION.md) is a faithful record of what was written on
> 2026-09-20, including its "Prior art" section. This investigation established
> that several of the prior-art claims recorded there are wrong or stale — most
> consequentially about BMAD-METHOD, GitHub Spec Kit and OpenSpec; see §2,
> "Corrections to the handoff's premises", below.
>
> `VISION.md` is **not** corrected. Correcting the record of what someone said
> destroys the thing that document exists to be. This report is copied here
> instead, unchanged apart from this note, so that the repository does not
> assert those claims with nothing to contradict them. Where this report and
> `VISION.md` disagree on a fact about an existing tool, this report is the
> later and better-evidenced account; where they disagree on what the captain
> intended, `VISION.md` stands.
>
> This report's recommendations are its author's, not rulings. Nothing in it
> has been adopted as an Entail decision.
>
> Source: `entail-priorart-b2`, dated 2026-09-20. Content preserved verbatim
> below.

---

# Entail: prior art investigation and shape recommendation

**Task:** `entail-priorart-b2` (scout) · **Date:** 2026-09-20 · **Deliverable:** this report; no code written, repository unchanged.

---

## 0. Summary of the recommendation

**Build Entail fresh.** Do not fork, extend, or compose on any existing tool. Steal two designs wholesale: OpenSpec's persistence model, and BMAD's delegation and review-triage machinery. Spec Kit's constitution gate is *not* a foundation and barely an influence — it is a prompt instruction with a self-service exemption table, and the handoff's description of it as a gate that "blocks plans" is wrong.

The load-bearing decision is not which tool to build on. It is **the artifact format**: Entail's artifacts must be *enumerated decision records, each citing the upstream anchor that determined it*, not prose documents. Every other capability the handoff asks for — leakage detection, review debt attribution, drift detection, the backlog view — falls out of that one choice mechanically, and none of them are reachable without it. The handoff leaves this open. It is the thing a builder would otherwise invent, and inventing it wrong makes the rest of the product impossible.

The handoff's central claim — that no prior art treats delegation depth as a concept — is **substantially correct but needs one significant correction**: BMAD's `bmad-build-auto` genuinely changes system behaviour under delegation, and BMAD already implements the exact granularity model the handoff proposes ("delegate by default, pin specific decisions"). Entail should generalise BMAD's mechanism across verticals rather than invent one.

---

## 1. What I did

Cloned and read the primary sources; did not rely on secondhand summaries except where a tool is closed-source.

| Source | Commit / version | Date |
|---|---|---|
| `bmad-code-org/BMAD-METHOD` | `f033e70` · main, `6.13.0-next` (latest **release** v6.12.0, 2026-09-04) | 2026-09-18 |
| `github/spec-kit` | `d4229c0` · `1.0.9.dev0` | 2026-09-18 |
| `Fission-AI/OpenSpec` | `bae58cf` · CLI **v1.13.1** installed and run | 2026-09-17 |
| `cameronsjo/spec-compare` | `58976eb` · last research sweep 2026-08-28 | 2026-09-11 |
| Kiro | kiro.dev docs (proprietary, no source) | fetched 2026-09-20 |

All three tool repos are **MIT**, so forking is legally clean. That is not the constraint; see §3.

I also **ran** OpenSpec rather than only reading it — installed v1.13.1, authored a custom schema expressing Entail's verticals, and probed its state model. Those experiments are in §2.3 and are the single strongest evidence in this report.

The handoff names `spec-compare` as worth reading. It is — as a map of the territory. It is not evidence: it is one person's independent research, it is explicitly "a considered opinion, not a benchmark", and I found it already out of date on BMAD (§2.5).

---

## 2. Corrections to the handoff's premises

The brief asks me to correct rather than confirm. Five of the handoff's claims are wrong or stale. Three of them change the design.

### 2.1 Spec Kit's "Constitution Check gate" does not block anything

> Handoff: *"A Constitution Check gate blocks plans that violate stated principles."*

It is a **heading in a Markdown template**, and the enforcement is a line of prose addressed to the model.

`templates/plan-template.md:39-43`:
```
## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
[Gates determined based on constitution file]
```

`templates/commands/plan.md` instructs the agent to "Fill Constitution Check section from constitution / Evaluate gates (ERROR if violations unjustified)". The same template then supplies the escape hatch, `templates/plan-template.md:106-112`:

```
## Complexity Tracking
> **Fill ONLY if Constitution Check has violations that must be justified**
| Violation | Why Needed | Simpler Alternative Rejected Because |
```

So the model detects its own violation, decides whether it is justified, and writes its own justification. I grepped the Python: the only code that touches the constitution is `src/specify_cli/commands/init.py:211` materialising the template file. Nothing validates a plan against it.

**Why it matters for Entail:** the handoff treats this as "the persistent-vision enforcement I wanted". It isn't enforcement. If Entail copies it, Entail gets nothing. This is the clearest example in the category of an analysis that exists as a prompt and produces no durable state — the theme of §2.4.

### 2.2 OpenSpec is no longer a three-phase state machine

> Handoff: *"Three-phase state machine."*

OpenSpec has been rebuilt around **OPSX**, a schema-driven artifact DAG. `docs/opsx.md` is explicit that the phase model was the thing they removed: *"Actions, not phases — create, implement, update, archive — do any of them anytime"*, and *"Dependencies are enablers — they show what's possible, not what's required next."*

The `specs/` + `changes/` + `archive/` persistence the handoff praises is intact and still the best in the category. But the workflow around it is now a user-definable dependency graph. This is *better* for Entail than the handoff assumes, and it changes the fork/compose analysis (§3).

### 2.3 OpenSpec's "done" means "the file exists" — nothing more

Not a handoff error, but the most important fact I established, and it is not documented anywhere I could find. I proved it by running the tool.

`src/core/artifact-graph/state.ts` detects completion purely by file existence. I built a project with a custom `entail` schema (`vision → architecture → tasks`) and probed it:

```
$ printf '# Vision\n\nTBD.\n' > openspec/changes/build-entail/vision.md
$ openspec status --change build-entail --json
vision         done
architecture   ready

$ : > openspec/changes/build-entail/architecture.md     # zero bytes
$ openspec status --change build-entail --json
vision         done
architecture   done
tasks          ready

$ openspec validate build-entail
Change 'build-entail' is valid
```

A vision saying **"TBD."** is `done`. A **zero-byte** architecture file is `done`, unblocks tasks, and passes validation.

**This is decision leakage, demonstrated.** The most advanced artifact-graph engine in the category cannot distinguish "this layer decided" from "this file exists". Entail's whole premise is that it must.

I also tested whether Entail's concepts could be carried as extra schema fields:

```yaml
  - id: architecture
    requires: [vision]
    delegation: derived           # not an OpenSpec field
    pins: [artifact-format]       # not an OpenSpec field
    determines: [module-boundaries, storage-format]
```
```
$ openspec schema validate entail
✓ Schema 'entail' is valid
$ openspec instructions architecture --change build-entail --json
keys returned: ['artifactId','changeDir','changeName','dependencies','description',
 'existingOutputPaths','instruction','outputPath','planningHome','resolvedOutputPath',
 'root','schemaName','template','unlocks']
  'delegation' present: False
  'pins' present: False
  'determines' present: False
```

OpenSpec **accepts the fields as valid and silently discards them.** They never reach the agent. Composing Entail's policy on OpenSpec's schema would not merely be unsupported — it would validate clean and do nothing. (Cause: `ArtifactSchema` in `src/core/artifact-graph/types.ts` is a non-strict Zod object with a closed field set: `id, generates, description, template, instruction, requires`.)

### 2.4 BMAD does *not* relay through the human at every handoff

> Handoff: *"BMad relays through the human at every handoff."*

BMAD ships two structurally different implementations of the same workflow — `bmad-build` (attended) and `bmad-build-auto` (unattended) — and they behave differently when upstream information is missing. This is the one real delegation mechanism in the prior art, and the handoff misses it.

Attended, `skills/bmad-build/step-02-plan.md:43`:
> "**Open Questions.** Present every entry as a numbered question with its options and what each option means, and **HALT for the human's answers**."

Unattended, `skills/bmad-build-auto/step-02-plan.md:25`:
> "If intent gaps exist, **do not fantasize and do not leave open questions.** Multiple defensible readings of the intent that lead to observably different outcomes, with nothing in the intent to select between them, are an intent gap — **do not resolve one by picking a reading.** HALT with status `blocked`, blocking condition `intent gap`, and include the unanswered questions and evidence gathered."

That second sentence is an operational definition of *failure to determine*, as distinct from contradiction, and it is exactly the default behaviour the handoff says it wants ("a vertical that depends on another should flag rather than improvise"). It is already written, already tied to the delegation posture, and it persists the result as machine-readable frontmatter rather than a chat message.

The related instruction at `skills/bmad-build/step-02-plan.md:32` is the anti-leakage rule stated directly:
> "**Never write an intent gap into the frozen block as an assumption.**"

### 2.5 The category's ceremony problem was addressed three weeks ago

> Handoff: *"Known problems in the category: … ceremony overhead on small changes."*

True when written about generally, but BMAD's released **v6.12.0 (2026-09-03)** headline is precisely this fix:

> "**Build decides how much ceremony a change needs after investigating it, not before.** Simple changes now get a two-section spec and finish in one session."

And BMAD's routing guidance (`skills/bmad/references/help.md`) now opens with:
> "**Trivial.** The edit is obvious and low-risk: make it directly and **use no BMad skill at all**."

`spec-compare` still rates BMAD ⭐⭐ for iterative change and says "21 agents for a button color change" (`docs/iterative-development.md:268-295`), pinned at v6.11.0 — its last sweep was 2026-08-28, six days before the release that fixed it. So the handoff inherited a critique that is one release stale, via a source that is one release stale.

Two further stale details, minor: Spec Kit is now **50 integrations**, not "30+", and its core path is six stages, not five — `constitution` once per project, then `specify → plan → tasks → implement → converge` per feature, with `converge` a new drift-closing loop. BMAD's agent personas are now explicitly demoted: *"Agent personas (optional) — No path above needs them; the flow skills already do this work."* The handoff's "agent personas per role" framing describes BMAD v4/v5, not v6.

### 2.6 Kiro: the handoff is right, but the interesting part is elsewhere

"Vendor-locked, metered" is accurate (proprietary; Pro $20/mo through Power $200/mo), though there is now a free tier, a CLI, and GA status. More useful: Kiro's **Quick Spec** "auto-generates all three artifacts without approval gates", chosen per session — so the handoff's "Kiro gates all three phases with approval" is no longer uniformly true.

And Kiro's own documentation confirms the handoff's thesis precisely. On Autopilot vs Supervised:

> "The distinction is primarily about auto-applying file edits, not about the agent's reasoning or escalation behavior. … **the agent's reasoning and decision-making logic remain consistent.** What changes is the execution flow."

That is the handoff's "you can fake partial delegation by not reading the output" — stated by the vendor, about their own product.

### The theme these corrections share

Across all four tools, **the analysis Entail needs already exists as a prompt, and is then thrown away.**

- Spec Kit `/clarify` builds a Clear/Partial/Missing coverage map over a taxonomy of decision categories — then: *"do not output raw map unless no questions will be asked."* Never written to disk.
- Spec Kit `/analyze` has a Coverage Gaps pass and a Coverage Summary Table — but is "**STRICTLY READ-ONLY**: Do not modify any files."
- OpenSpec `/opsx:verify` produces a three-dimension scorecard (Completeness/Correctness/Coherence) — as chat output.

Two exceptions, both instructive: Spec Kit's `converge` appends its findings to `tasks.md` as real work, and BMAD's build-auto writes `status: blocked` + blocking condition into the spec frontmatter. **Those two are the design pattern Entail should follow: analysis that becomes state.**

---

## 3. Question 1 — Build fresh, fork, extend, or compose?

### Recommendation: build fresh. Single answer, no menu.

**Is OpenSpec a foundation or an influence?** Its *persistence model* is a foundation — copy it almost verbatim. Its *codebase* is not, and cannot be.

The reason is narrow and decisive, and I established it by experiment (§2.3): OpenSpec's artifact state is file existence. Every capability Entail exists to provide requires a richer state — at minimum `determined | undetermined | stale`. That state model is not a feature of OpenSpec you could add alongside; `detectCompleted` is the centre of the engine and `status`, `instructions`, `apply`, `list` and the generated skills all hang off it. You would be replacing the core on day one and then carrying the diff forever against a project that just rewrote its entire workflow (legacy → OPSX) and is mid-rewrite again (Stores beta, `initiatives/`, `work/`).

The "compose on top" option is worse than it looks, and this is the part I would not have guessed without running it: OpenSpec silently accepts unknown schema fields and silently drops them. A delegation policy written that way validates clean and has no effect. That is the worst possible failure mode for a product whose entire purpose is preventing silent gaps.

There is also a tell worth weighing. **OpenSpec could not express standing verticals in its own engine either.** Its repository contains `openspec/initiatives/` (with `direction.md`, `decisions.md`, `questions.md`, `roadmap.md`) and `openspec/work/` (with `goal.md`, `slices/`) — hand-rolled directories, governed by a hand-written `.initiative.yaml` and a README, sitting entirely outside the schema engine they built. The authors of the best artifact-graph engine in the category route their own product direction around it. Entail's artifacts are change-scoped in OpenSpec's model (`openspec/changes/<name>/`); the standing layer Entail needs has no home there.

**Is Spec Kit's constitution gate a foundation?** No, and it is barely an influence. It is a prompt with a self-justification table (§2.1). What *is* worth taking from Spec Kit is two things it does not advertise: the `/clarify` **decision-category taxonomy** (a genuinely good enumeration of what an upstream artifact must determine) and `converge` (analysis persisted as work). Take those; leave the constitution.

**What building fresh costs, honestly.** You give up: 30–50 tool adapters, a tested CLI, delta-spec parsing, archive/sync machinery. The reason that bill is affordable is a constraint the handoff already accepted — single personal user, local-first. You need **one** harness adapter, not fifty. Multi-tool portability is the single largest chunk of all three codebases and Entail needs none of it. Remove that, and OpenSpec's remaining irreducible cleverness is the DAG resolver and the delta-merge — perhaps a week of work, against a permanent merge burden.

**What Entail inherits by choosing this route**, concretely and with attribution:

| From | Take | Where |
|---|---|---|
| OpenSpec | `specs/` (current truth) + `changes/` (proposals) + `archive/` (merged), delta ops ADDED/MODIFIED/REMOVED/RENAMED | `schemas/spec-driven/schema.yaml` |
| OpenSpec | Artifact DAG where dependencies **enable** rather than gate | `docs/opsx.md` |
| OpenSpec | Slice handoff as **index + fetch**, never inlining | §4.3 |
| OpenSpec | Project `context:` and per-artifact `rules:` injection | `openspec/config.yaml` |
| BMAD | Attended/unattended as *different workflows*, not a flag | `skills/bmad-build-auto/` |
| BMAD | `route_source: pinned \| auto` — the pin mechanism | `skills/bmad-build/spec-template.md:7` |
| BMAD | `<frozen-after-approval>` — machine-readable authority boundary | `spec-template.md:20-49` |
| BMAD | Review triage by **location of root cause** | `step-04-review.md:79-86` |
| BMAD | Ceremony decided *after* investigation | v6.12.0 |
| Spec Kit | `/clarify` decision-category taxonomy | `templates/commands/clarify.md` |
| Kiro | `inclusion: always \| fileMatch \| auto \| manual` conditional context | `.kiro/steering/` |

**What Entail would fight against in each rejected option** (asked for explicitly):

- *Fork OpenSpec:* the file-existence state model (its core), change-scoping of all artifacts, a fast-moving upstream mid-rewrite, and 50 tool adapters you must keep working but do not want.
- *Fork/extend BMAD:* a Jinja-rendered skill-snapshot runtime with a hard `uv`/Python 3.11 dependency, layered TOML config resolution, and ~31 skills of surface area. Its *ideas* are the best in the category; its *machinery* is the heaviest. Take the ideas.
- *Fork Spec Kit:* you would inherit the thing you are trying to fix (enforcement-by-prompt) plus a Python CLI whose main value is 50 integrations you do not need.
- *Compose on OpenSpec:* silent field-dropping (§2.3). Disqualifying.
- *Build on Kiro:* proprietary, metered, no source, and its autonomy control is explicitly not a reasoning control.

---

## 4. Question 2 — The artifact set

### 4.1 Eight verticals collapse to two standing artifacts, one conditional

The handoff lists: product decisions, product vision, software architecture, high-level software decisions, UI design, development, testing, validation.

**These earn a standing, persistent artifact:**

1. **Vision** — absorbs *product vision* + *product decisions*. They collapse because a product decision separated from the vision that justifies it is precisely the artifact Entail exists to prevent; the decision log has no other home, and "why" and "what we chose" want to be read together. Holds: the problem, who it is for, non-goals, and the enumerated product decisions with rationale. Prior art agrees by converging on one file: Kiro `product.md`, Spec Kit `constitution.md`, BMAD product-brief→PRD.

2. **Architecture** — absorbs *software architecture* + *high-level software decisions*. Same argument; the distinction between "architecture" and "a high-level software decision" is not one anybody can hold consistently, and BMAD already merges them: `bmad-architecture` "records the how-to-build decisions that keep separately built parts consistent". Holds: module boundaries, data/storage shape, dependency rules, and the technical decisions with rationale and the vision anchor each derives from.

**This earns a conditional artifact:**

3. **Interface** (the handoff's *UI design*) — exists only when the product has a surface worth deciding about. BMAD makes exactly this call: `bmad-ux` "belongs after the PRD **when a UI is a significant part of the work**". Kiro folds it into `product.md` entirely. For Entail-building-Entail, a local CLI, this artifact does not exist at v1. Do not create an empty one — an empty artifact that reads as `done` is the failure mode from §2.3.

**These do not earn artifacts at all:**

4. **Development, testing, validation.** These are *activities*, not verticals with persistent upstream state. No tool in the category gives testing or validation a standing artifact; in every one of them these are change-scoped (`tasks.md`, verification sections, review logs). The parts that genuinely persist — "we use property tests for the parser", "no network in unit tests" — are *architecture decisions* and belong in artifact 2. Giving them their own artifacts would create three files that are either empty or duplicate architecture, and would triple the drift surface for nothing.

**The backlog is a derived view, not an artifact.** The handoff describes it as "a view of what should be built next given what the vision and architecture say" — that is a query, and it should be computed, never authored. Every hand-maintained backlog is a fourth thing to drift. Concretely, `entail next` should return: open (undetermined) decisions, decisions whose upstream anchor changed, and architecture decisions with no corresponding code anchor. This is my opinion and it is a real design commitment — it means the backlog can never say something the artifacts do not.

**Net: 2 standing + 1 conditional + a derived view.** Eight to two is a large collapse and I want to be clear it is a recommendation, not a finding. The evidence behind it is that every mature tool in the category independently converged on roughly three persistent files (Kiro's `product`/`tech`/`structure` is the cleanest example), and none converged on eight.

### 4.2 What a decision record must contain

This is the part the handoff leaves open and the part everything else depends on. My recommendation, stated as a format:

```markdown
### D-017: Artifacts are decision records, not prose documents
status: determined            # determined | open | stale
authority: mine               # mine | derived
determined-by: vision#D-004   # the upstream anchor; REQUIRED when authority=derived
rationale: >
  D-004 requires that a delegated layer be auditable after the fact.
  Prose cannot be cited, so it cannot be audited.
alternatives-rejected:
  - Prose documents with section anchors — anchors are not stable under editing.
realised-by: src/artifact/record.ts
```

The two fields doing the real work are `determined-by` and `status: open`. A derived decision with no `determined-by` is a leak, detectable by link-checking rather than by inference. An `open` record is the flag-don't-improvise behaviour made durable.

### 4.3 How a downstream layer receives its slice

**Index always, body on demand. Never inline the upstream artifact.**

This is not my invention; it is the pattern OpenSpec arrived at and the one thing in its design I would copy without modification. Its cross-store references produce "an index of each referenced store's specs — spec ids, a one-line summary from each spec's Purpose section, and the fetch command", and explicitly: **"spec content is never copied into the output"** (`docs/cli.md:340`). Its per-artifact handoff is likewise a pointer, which I confirmed by running it:

```json
"dependencies": [
  { "id": "vision", "done": true, "path": "vision.md",
    "description": "Product vision and problem statement" }
],
"unlocks": ["tasks"]
```

For Entail the slice should be: **the full decision index of every upstream artifact** (id + one-line statement + status), **plus** the bodies of decisions the downstream layer cites. That inverts the usual context problem — the downstream layer always knows *what was decided upstream* (cheap, a list of one-liners) and pulls *why* only where it is deriving from it. It also makes the citation requirement natural rather than bureaucratic: you had to look the anchor up to write the decision.

Kiro's `inclusion: fileMatch | auto` is the other half worth borrowing — conditional loading by file pattern or by description-match — if the index ever outgrows the context budget. At personal-project scale it will not for a long time.

---

## 5. Question 3 — The delegation dial

### 5.1 The test that separates a real dial from a fake one

From the evidence, the distinction is sharp and checkable: **does the escalation path change?**

- Kiro Autopilot: no. The vendor says so — "the agent's reasoning and decision-making logic remain consistent. What changes is the execution flow." This is "the human does not look", productised.
- Kiro Quick Spec: no. Removes approval gates; the agent derives identically.
- Spec Kit: no posture at all. `/clarify` is interactive-only; skip it and nothing changes except a warning.
- BMAD build vs build-auto: **yes.** Same intent gap produces "HALT and ask the human" in one and "HALT with `status: blocked`, blocking condition `intent gap`, include the unanswered questions" in the other.

So the handoff's claim needs amending to: *no prior art treats delegation depth as a first-class, cross-cutting concept* — which I verified by grepping all three codebases for delegation-depth vocabulary (`delegation depth|dial|level|mode`, `autonomy level`, `trust level`, `approval depth`): **zero hits in BMAD, zero in Spec Kit, one in OpenSpec** (unrelated — a Codex skills trust setting). But BMAD has the mechanism at one layer, and Entail should generalise it rather than start over.

### 5.2 Proposed representation

Delegation is recorded **in the artifact's own front-matter** — diffable, reviewable, local, consistent with the accepted constraints:

```yaml
---
artifact: architecture
authority: derived          # mine | derived
pins:
  - D-004                   # a decision I have already made and own
  - topic: storage-format   # a decision that does not exist yet, which I want
  - topic: anything-affecting-the-artifact-format
---
```

Two rules make the system *know* a layer is delegated, rather than merely unobserved:

**Rule 1 — a derived layer has exactly two legal moves.** Either emit a decision with a resolvable `determined-by` anchor, or emit `status: open` with the candidate readings. It may not emit an uncited determined decision. This is mechanically checkable; it does not depend on the model noticing anything.

**Rule 2 — escalation shape follows authority, and is not separately settable.** Under `authority: mine`, an undetermined decision stops and asks. Under `authority: derived`, there is no human in the loop by construction, so it writes an `open` record and blocks anything downstream that would need it. This is BMAD's attended/unattended split, generalised from one layer to all of them.

### 5.3 On the handoff's proposed granularity

> Handoff: *"Probably not per-vertical in practice. More likely delegate a vertical by default and pin specific decisions I care about."*

**This is right, and it is already validated by shipping prior art** — which the handoff does not know. BMAD implements exactly this shape:

`skills/bmad-build/spec-template.md:6-9`
```yaml
route: ''         # oneshot | full — set by step-02
route_source: ''  # pinned | auto — set with route by step-02
review: ''        # none | quick | thorough — set by step-04
review_source: '' # pinned | auto — set with review by step-04
```

`spec-template.md:20`
```
<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
```

`route_source: pinned | auto` records, per dial, whether the human pinned it or the agent chose — "delegate by default, pin what I care about", verbatim. The frozen block is the sub-artifact authority boundary, and it is load-bearing: step-03 treats it as read-only, and step-04 routes findings by whether the root cause sits inside it.

**One refinement, and I believe it is the only genuinely novel thing required.** BMAD's frozen block is populated by the human *up front* — you can only pin a decision you have already made. That is insufficient for the handoff's actual use case, which is "I do not know what the architect will decide, but if it touches storage format, stop." Pins must therefore be expressible over **topics that do not have decisions yet**, not only over existing decision ids. Hence the `- topic:` form above.

This has a real cost worth stating: topic-matching is fuzzy, so a pin can miss. Mitigation — a delegated layer must list, in its output, every decision it made and which pins it checked them against. A missed pin then shows up in a diff rather than never.

### 5.4 The dial is about authority; keep depth separate

BMAD's `route: oneshot|full` and `review: none|quick|thorough` are *effort* dials, not *authority* dials, and BMAD keeps them as separate fields. Entail should too, and should adopt BMAD v6.12.0's rule that effort is chosen **after investigation, not before**. Conflating "how much work" with "who decides" is how you end up with Kiro's Autopilot — a control that feels like delegation and changes nothing about reasoning.

---

## 6. Question 4 — The three open questions

### 6.1 Decision leakage

**What prior art does.** Ranked by usefulness:

1. **BMAD, best.** The operational definition at `bmad-build-auto/step-02-plan.md:25` — multiple defensible readings → observably different outcomes → nothing upstream selects between them — is a genuine test for *failure to determine* rather than contradiction, and it is tied to the delegated posture. Plus the prohibition at `bmad-build/step-02-plan.md:32`: "Never write an intent gap into the frozen block as an assumption."
2. **Spec Kit `/clarify`.** A taxonomy of ~10 decision categories, each scored Clear / Partial / Missing. The right idea; discarded, human-interactive, and run on the spec rather than at the downstream consumption boundary.
3. **Spec Kit `/analyze`, Coverage Gaps.** "Tasks with no mapped requirement/story" is the correct *direction* — a downstream item with no upstream determinant. But it is keyword-inferred, one-shot, read-only, and only requirement→task.
4. **OpenSpec: nothing.** Empirically, an empty file is `done` (§2.3).

**Can it be solved reliably? No.** I want to be direct about this rather than hedge.

The reason is structural, not a matter of better prompting. Detecting that an upstream artifact failed to determine a decision requires enumerating the readings it failed to select between. A model that did not notice it was making a decision will not enumerate that decision when asked to audit itself. You are asking one fallible pass to find its own blind spot. Contradiction detection does not have this problem, because the contradicting text is present and findable — which is exactly why the handoff is right that the two cases are asymmetric, and why every tool in the category does the easy one.

**Partial mitigations worth having, in order of value:**

1. **Convert detection into a write obligation.** This is the main proposal and the reason for the artifact format in §4.2. Require every derived decision to cite a resolvable upstream anchor. Then a leak is not something you *detect by reasoning* — it is a decision with an empty or dangling `determined-by`, found by link-checking. This turns an unsolvable inference problem into a graph problem, and the check needs no model at all.
2. **Adopt BMAD's two-readings test verbatim** as the authoring rule for when to write `status: open` instead of a decision. It is well-phrased, it is in use, and there is no reason to write a worse version.
3. **Persist Spec Kit's coverage map.** Keep the taxonomy, write the Clear/Partial/Missing result to disk next to the artifact instead of discarding it. Cheap, and it makes gaps visible across sessions and diffable over time — which is the handoff's "persistence is what makes separation worth anything" applied to the gaps themselves.
4. **Let review-debt machinery catch the rest** (§6.2).

**What this does not catch, stated plainly.** Mitigation 1 catches "the agent was deriving something and had nothing to point at". It does **not** catch "the agent never registered that a decision was being made" — the invisible-choice case. Nothing I found, and nothing I can propose, catches that reliably. Entail should not claim otherwise. The honest posture is that Entail makes leakage *visible and attributable after the fact* rather than *impossible*, and §6.2 is how it pays that off.

### 6.2 Review debt

**What prior art does.** BMAD solves this, well, and it is the most transferable thing in the survey. `skills/bmad-build/step-04-review.md:79-86` routes every review finding to a layer of origin:

- `intent_gap` — "Root cause is **inside** `<frozen-after-approval>`" → revert code, return to the human, re-plan.
- `bad_spec` — "Root cause is **outside** `<frozen-after-approval>`" → revert code, amend the derived spec, re-derive.
- `patch` — the code is simply wrong → smallest fix, no loopback.
- `defer` — pre-existing, not this change's problem.

The elegance is that the primary test is **a location test, not a judgement**: is the root cause inside the human-owned block or outside it? That is precisely the handoff's question — "a bad implementation of good architecture, or a faithful implementation of bad architecture?" — made answerable. BMAD adds an append-only `## Spec Change Log` recording the triggering finding, what was amended, the known-bad state avoided, and "KEEP instructions", plus a loopback counter that escalates to the human after 5.

**What I propose.** Generalise from BMAD's two layers to Entail's N verticals — and note this comes free if §4.2 is adopted. If every decision cites its determinant, a defect's root cause is *the highest artifact in its citation chain that is wrong*. Walking the chain is mechanical. Concretely, on a defect: find the code's `realised-by` decision, walk `determined-by` upward, and ask at each step only "is this one wrong?" — a local question with a yes/no answer, rather than the global question that makes review debt intractable.

This is the payoff that justifies the citation discipline. Without it, citations are bureaucracy; with it, they are the audit trail that makes delegation safe to reverse.

**On the handoff's own position** — *"delegated output needs a different shape than reviewed output: enumerated decisions with rationale, not a long document"* — I agree, strongly, and note it is not merely a preference: it is forced. Citations require addressable anchors, and prose does not have stable ones. So the handoff's instinct about review debt and the artifact format decision in §4.2 are the same decision. The handoff does not appear to have noticed that.

### 6.3 Granularity of the dial

Answered in §5.3. Summary: the handoff's position is correct, BMAD already validates the shape (`route_source: pinned|auto` + `<frozen-after-approval>`), and the one missing piece is that pins must cover **topics that have no decision yet**, not only existing decision ids — otherwise you can only pin what you already thought of, which defeats the purpose.

---

## 7. Question 5 — The category's known failure modes

### 7.1 Spec drift

**What the category does.** OpenSpec is best (delta + `sync` + `archive`, "spec-anchored" rather than "spec-first"). Spec Kit's `converge` is newer and in one way better: it writes drift back as executable tasks rather than a report. `/opsx:verify` detects code↔spec divergence but only as chat output.

**What Entail does differently.** Entail's standing artifacts drift in a way the category has not addressed: they go **stale** rather than being contradicted. An architecture decision derived from a vision statement that has since changed is not contradicted by anything — it is simply no longer entailed.

Proposal, and it is deterministic: **store a content hash of the cited anchor alongside each citation.** When an upstream decision's text changes, every dependent decision is mechanically marked `stale`. No model call, no inference, no drift heuristic — a hash comparison. `entail check` then reports exactly which downstream decisions need re-derivation, and `entail next` surfaces them.

I rate this the highest-confidence proposal in the report, because it is the one that cannot be wrong: either the hash matches or it does not.

### 7.2 Ceremony overhead on small changes

**What the category does.** Largely solved in the last month, and Entail should simply adopt the answer rather than rediscover it. BMAD v6.12.0: ceremony decided *after* investigating, not before; trivial changes use no tooling at all. Spec Kit: three independent entry points, SDD not mandatory. Kiro: Quick Spec.

**What Entail does.** Two commitments:

1. **A zero-artifact path, and it must be the default.** The trigger for ceremony is not size — it is *"does this change a decision, or need one that does not exist?"* If neither, Entail produces nothing and gets out of the way. This is a sharper trigger than BMAD's scope tiers because Entail actually knows what the decisions are; BMAD has to estimate scope, Entail can check the decision graph.
2. **Ceremony chosen post-investigation**, recorded as `route`/`route_source` the way BMAD does, so the choice is auditable and pinnable.

The structural advantage is worth stating: because Entail's artifacts are enumerated decisions rather than documents, the *unit of ceremony is one decision record*, not one document. "Change button blue to green" adds zero decisions and costs nothing. The category's ceremony problem is substantially an artifact-granularity problem, and §4.2 dissolves most of it as a side effect.

### 7.3 Weak codebase alignment on large repos

**What the category does.** Least well of the three. OpenSpec is brownfield-first and has `docs/existing-projects.md`; BMAD's `bmad-project-context` writes one verified block into `AGENTS.md` (having deliberately removed its older generated-documentation approach); Spec Kit added an existing-project guide. None of them solve it.

**What Entail does, with a caveat I want to be explicit about.** The `realised-by` field in §4.2 anchors each architecture decision to the code that implements it, so alignment becomes checkable: does the anchor still exist, and does the code there still match? That gives a concrete, cheap signal (`entail check` reports decisions whose `realised-by` path is gone).

**This is my weakest recommendation and I am not going to dress it up.** It degrades on a large repo in an obvious way: a decision like "all I/O goes through the adapter layer" is realised by hundreds of sites, not one path, and a single anchor is then a token gesture. I did not test this at scale, nobody in the category has solved it, and Entail's accepted constraints (personal project, one user) mean v1 will not encounter the hard version. I would ship the anchor, treat it as a convenience rather than a guarantee, and revisit when there is a real large repo to test against. Claiming more than that would itself be decision leakage.

---

## 8. Question 6 — Recommended first milestone

The smallest thing that is genuinely useful alone and actually tests the premise. The test is not "does it produce artifacts" — every tool does. The test is **does separation plus delegation change the output**.

### In scope

1. **Two artifacts**, `entail/vision.md` and `entail/architecture.md`, each a list of decision records in the §4.2 format. Vision is authored by the human; architecture is derived.
2. **Front-matter authority and pins** on each artifact: `authority: mine | derived`, `pins: [<id> | topic: <text>]`.
3. **`entail derive <artifact>`** — assembles the upstream decision index, derives the artifact, and enforces Rule 1: every determined decision carries a resolvable `determined-by`, everything else becomes `status: open`. Refuses to proceed downstream past an `open` decision covered by a pin.
4. **`entail check`** — pure mechanical, no model: dangling citations, uncited derived decisions, anchor-hash mismatches (`stale`), `open` decisions blocking downstream, missing `realised-by` paths.
5. **`entail next`** — the derived backlog view (§4.1).
6. **One harness adapter** — whichever agent is actually in use.

### Deliberately deferred

- **The interface/UX artifact.** Entail is a CLI; creating it empty would manufacture the §2.3 failure.
- **Testing and validation verticals.** They are activities (§4.1).
- **The entire change/proposal/archive lifecycle.** This is the biggest deliberate saving, and it is defensible rather than lazy: with one user and a git repository, *the archive is the git log*. OpenSpec needs deltas and archiving because it supports teams and cross-repo stores; Entail at v1 can let the user edit the artifact and let `git log -p` be the history. Reconsider if and only if a second user appears — which the constraints say will not happen.
- **Automatic leakage detection.** Ship only the mechanical citation check (§6.1 mitigation 1). Do not attempt the inference version; §6.1 argues it cannot be made reliable.
- **Multi-tool adapters, hosting, sync, any UI.**
- **The persisted coverage map** (§6.1 mitigation 3) — valuable, but it is an addition to a working citation graph, not a prerequisite.

### The proof criterion

Use Entail to build Entail — which is the captain's stated intent, and conveniently also the sharpest available test. Concretely:

> Write the vision artifact by hand from the handoff. Set `architecture` to `authority: derived` with one pin: `topic: artifact-format`. Run `entail derive architecture`.

**It passes if** the architecture that comes back cites vision anchors for its derived decisions, emits `status: open` for what the vision genuinely does not determine, and **stops** on the pinned topic instead of deciding it. **It fails if** it produces a confident, complete architecture document — because the vision as written does not determine one, and a complete answer would prove the system is improvising exactly as the handoff fears.

That is a one-week build with a falsifiable outcome, which is the main thing I would want from a first milestone.

---

## 9. Gaps the handoff leaves genuinely undetermined

The brief asks me to name what a builder would have to invent. This section is, by the handoff's own logic, the most important one — these are the live leakage risks on this very project.

1. **The artifact format. Load-bearing and unstated.** The handoff names it as an open product decision; it is not merely open, it is the decision the rest of the design depends on. A builder handed this handoff would most naturally produce *prose documents* (that is what every tool in the category does). Prose has no stable anchors, so citation is impossible, so leakage detection, review-debt attribution and drift detection are all impossible. Choosing prose quietly forecloses the product's three differentiators without anyone noticing. **This is the one gap I would escalate before any code is written.**

2. **Where the orchestrator runs.** The handoff says "an orchestrator" and never says whether that is a CLI the user invokes, a skill inside their agent, a long-running process, or a library. Prior art is split (OpenSpec: CLI + generated skills; BMAD: rendered skills + Python runtime; Spec Kit: CLI + skills). This changes essentially every implementation decision and the handoff does not constrain it.

3. **How standing verticals relate to per-change work.** The single largest structural gap. Does a change *amend* the architecture artifact, or *reference* it and record its own deltas? OpenSpec answers with deltas + archive; the handoff is silent. A builder must invent this, and the two answers produce different products. (My §8 defers the question by having changes edit artifacts directly with git as history — but that is my choice, not the handoff's.)

4. **Whether the backlog is authored or derived.** The handoff says it "sits across all of it" without saying who writes it. I recommend derived (§4.1); authored would be a materially different product with a different drift profile.

5. **What delegating an already-written artifact means.** If I flip architecture from `mine` to `derived`, does Entail re-derive it, leave it, or diff the two? Unaddressed, and it is the common case after the first week.

6. **No success criterion anywhere.** The handoff says the goal is "to increase the leverage I get from LLMs without paying for it in quality" but offers no way to tell whether that happened. §8's proof criterion is my invention, not the handoff's. Worth the captain stating one.

7. **Pin semantics on a topic that never comes up.** If I pin `topic: storage-format` and the delegated layer never makes such a decision, is that success or a silent miss? Not addressed by the handoff, and not addressed by prior art either.

---

## 10. What I could not verify

- **Kiro** is proprietary with no source. Everything about it here comes from kiro.dev documentation fetched 2026-09-20 and from `spec-compare`. I did not run it (metered, no account). In particular, the Autopilot/Supervised characterisation is from a documentation summary, not from observed behaviour — though it is a direct quote of the vendor's own claim, which is the strongest form available for a closed product.
- **BMAD version skew.** I read `main` at `f033e70` (`6.13.0-next`, unreleased). The latest *release* is v6.12.0 (2026-09-04). I confirmed the ceremony change is in the released v6.12.0 changelog, but the exact file contents I quote — `spec-template.md` frontmatter, the step-02 intent-gap rule, the step-04 triage — are from `main` and may differ slightly from what a user installs today.
- **I ran only OpenSpec.** Spec Kit and BMAD were read (templates, skills, commands, Python) but not executed end to end. My claims about them are claims about what their instructions say, which for prompt-driven tools is most of what there is — but it is not the same as observed behaviour, and for BMAD in particular the Jinja rendering means the file I read is not exactly the text the model receives.
- **`spec-compare` is one person's research**, last swept 2026-08-28, and I demonstrated it is already stale on BMAD (§2.5). I used it as a map of what exists, and verified independently everything I relied on.
- **Scale claims are untested.** Nothing here was tried on a large repository (§7.3), and my hash-based staleness proposal (§7.1), while deterministic, has not been tried on an artifact set large enough to know whether it produces useful signal or constant noise.

---

## 11. Decision required from the captain

One genuine product call, which gates `entail-seed-a1` (seeding the repository with the vision artifact):

**What shape are Entail's artifacts?**

- **(A) Enumerated decision records with upstream citations** — my recommendation (§4.2). Unlocks leakage detection, review-debt attribution and drift detection as mechanical checks. Costs: more structure to author; the vision artifact becomes a decision list rather than a narrative.
- **(B) Prose documents** — what every tool in the category does. Cheaper and more natural to write, and the handoff reads as though it assumes this. Forecloses all three differentiators, because prose has no citable anchors.
- **(C) Hybrid** — prose body with a structured decision index appended. Plausible middle ground; risk is that the two halves drift from each other, which is the failure this product exists to prevent, reproduced inside a single file.

Bundled with it, because it follows directly: **build fresh** (§3) rather than fork or compose. I consider this well-evidenced rather than a close call, but it is the captain's call to take.

---

## Appendix — key evidence index

| Claim | Source |
|---|---|
| Constitution gate is prose + self-justification | `spec-kit templates/plan-template.md:39-43, 106-112`; `templates/commands/plan.md` |
| Only code touching constitution is template materialisation | `spec-kit src/specify_cli/commands/init.py:211` |
| OpenSpec completion = file existence | `openspec src/core/artifact-graph/state.ts` |
| Empty file reads as `done`, passes validate | run: `openspec status/validate`, §2.3 |
| Unknown schema fields validate then vanish | run: `openspec schema validate` + `instructions`, §2.3 |
| Closed artifact field set | `openspec src/core/artifact-graph/types.ts` (`ArtifactSchema`) |
| Slice handoff is a pointer; content never copied | `openspec docs/cli.md:340`; run: `openspec instructions --json` |
| OpenSpec hand-rolls standing layer outside its engine | `openspec/initiatives/`, `openspec/work/`, `.initiative.yaml` |
| Intent-gap definition (failure to determine) | `bmad skills/bmad-build-auto/step-02-plan.md:25` |
| Never record a gap as an assumption | `bmad skills/bmad-build/step-02-plan.md:32` |
| Attended asks; unattended writes blocked status | `bmad step-02-plan.md:43` vs `bmad-build-auto/step-02-plan.md:25` |
| Pin mechanism (`pinned \| auto`) and frozen block | `bmad skills/bmad-build/spec-template.md:6-9, 20-49` |
| Review triage by root-cause location | `bmad skills/bmad-build/step-04-review.md:79-86` |
| Ceremony decided after investigation | `bmad CHANGELOG.md` v6.12.0 (2026-09-03) |
| Trivial tier uses no tooling | `bmad skills/bmad/references/help.md` |
| Coverage map computed then discarded | `spec-kit templates/commands/clarify.md` step 3 |
| Analyze is strictly read-only | `spec-kit templates/commands/analyze.md` |
| Autopilot does not change reasoning | kiro.dev/docs/ide/chat/autopilot/ |
| Quick Spec removes approval gates | kiro.dev/docs/specs/quick-spec/ |
| Steering inclusion modes | kiro.dev/docs/steering/ |
| No delegation-depth vocabulary in any codebase | grep across all three repos, §5.1 |
| spec-compare stale on BMAD | `spec-compare docs/iterative-development.md:268-295` vs BMAD v6.12.0 |
