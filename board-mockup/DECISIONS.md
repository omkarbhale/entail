# Decisions the board mockup needed

**Nobody has answered any of these.** Every question below is one this
mockup had to answer before a board could be drawn. Each one was answered with
an assumption only so the drawing could go ahead. **An assumption here is not
an answer.** It is what the mock server and the board currently do, and it is
there to be replaced.

Who wrote this: the worker that built the mockup. The captain has ruled on
none of it. Where a recorded file bears on a question, the file is named under
**Bears on it**. Naming it is not adopting it, and none of those files settles
any question below; if one did, the question would not be here.

This file sits beside the two packages and not under `unfiled/`, because
`unfiled/` holds recorded direction and this is invented material. Its layout
is ad hoc and is not a proposal for Entail's decision-record format.

**How the code uses it.** The mock server marks every value it serves with
provenance ([`mock-server/src/provenance.ts`](mock-server/src/provenance.ts)).
A value marked *interpreted* or *assumed* names one of the ids below. When the
server starts, it reads this file and refuses to run if any id it uses has no
heading here. Ids are therefore stable. Add new entries at the end and do not
renumber. An entry whose last line says *Nowhere in the mock* is one that the
building raised but that no served value depends on.

---

## A. What the board shows

### D-01. Is the board's unit a task, a stage, or a decision?

**Assumed to proceed (not an answer):** a task. The board has one row per
piece of work in flight, and that row moves through stages. Stages and
decisions do not appear as rows.

**Bears on it:** the board statement at
[design record, point 4](../unfiled/2026-09-20-pipeline-design-record.md#point-4--already-decided-matching-is-treated-as-free)
("showing all tasks and in-flight features and their status"). Against that:
VISION.md's "Delegation as a dial" and the review-debt question both put
decisions at the centre, which would make decisions a candidate unit.

**Where the mock depends on it:** the shape of `Item` in
`mock-server/src/contract.ts`.

### D-02. Are tasks, features, activities and products one kind of item, or kinds the board tells apart?

**Assumed to proceed (not an answer):** one kind. Items carry no type.

**Bears on it:** design record §1: "Somebody arrives and describes some task,
feature, activity, or a product to build."

**Where the mock depends on it:** `Item` has no kind field.

### D-03. What identifies an item to the user?

**Assumed to proceed (not an answer):** a short title. The sample titles are
placeholders. The mock does not say where a title would come from: the user's
own words, a summary of them, or something derived.

**Where the mock depends on it:** the `item.title` field.

### D-04. Is the board the backlog VISION.md describes, or a separate thing?

**Assumed to proceed (not an answer):** separate. The board shows work already
in flight. It does not show "what should be built next given what the vision
and architecture say".

**Bears on it:** VISION.md, "The concept" (the backlog), and
[open questions C4](../unfiled/2026-09-20-open-questions.md#c4-whether-the-backlog-view-is-authored-or-derived).

**Nowhere in the mock**, beyond the board holding no backlog.

### D-05. Does one board span one project or several?

**Assumed to proceed (not an answer):** one project. No project is named or
shown.

**Bears on it:** design record, point 3, where some settings are per project.

**Nowhere in the mock.**

### D-06. How does work get onto the board?

**Assumed to proceed (not an answer):** it does not. The board has no action
for starting work, so the items are seeded when the server starts. Submitting
work is outside this mockup's scope. It is recorded here because a board
nobody can add to is not how the real one can work.

**Bears on it:** design record §1, "Somebody arrives and describes some task…
That goes into a pipeline and follows it."

**Where the mock depends on it:** the seed list in
`mock-server/src/fiction.ts`.

### D-07. What happens when an item finishes its last stage?

**Assumed to proceed (not an answer):** nothing is allowed to happen. The
mock refuses to advance an item at the last stage. Nothing recorded says
whether the item then leaves the board, stays as done, or waits for a merge.

**Bears on it:** design record §1, "And so on, until the final pull request."

**Where the mock depends on it:** the advance rule in
`mock-server/src/rules.ts`.

### D-08. In what order are items listed?

**Assumed to proceed (not an answer):** the order the mock declares them in.
That is not a rule. Whether items that need the user come first, whether the
order follows the stages, or anything else, is open.

**Bears on it:** the board statement: items stop "only when they have
something to raise or the user is needed somewhere". That suggests, and does
not state, that those items matter most.

**Where the mock depends on it:** `board.items`.

### D-09. Is the board a list of items, or columns by stage?

**Assumed to proceed (not an answer):** a list. The UI shows one table, one
row per item, with the stage as a column. The stage sequence is shown once,
above the table, rather than as columns an item moves across.

**Where the mock depends on it:** the UI's layout, and the set of words
served in `board.labels`, which follows from it.

---

## B. Stages

### D-10. What stages exist?

**Assumed to proceed (not an answer):** six, in this order: Vision,
Decisions, Architecture, Development, Testing, Pull request.

**Bears on it:** design record §1. It describes checking the vision first,
then decisions, "and so on, until the final pull request". It names vision,
decisions and architecture as early layers where the user wants a say. It
names development, testing, performance validation, UX design, UX validation
and accessibility as runs the pipeline spawns. It does not say which of these
are stages a task passes through. See also
[open questions A1](../unfiled/2026-09-20-open-questions.md#a1-the-vertical-set).

**Where the mock depends on it:** `board.stages` and each stage's name, all
marked *interpreted*.

### D-11. Does every item pass through the same fixed line of stages?

**Assumed to proceed (not an answer):** yes. One linear list serves every
item. Nothing skips a stage, repeats one, or runs two at once.

**Bears on it:** design record §1, "Some of the runs are not mandatory", and
point 3, where whether a project wants a validation pipeline is a
per-project choice.

**Where the mock depends on it:** `board.stages` is a single list and the
advance rule moves to the next entry. The arrow drawn between stage names,
`board.labels.stageSeparator`, depicts that line.

### D-12. Are the runs the pipeline spawns stages, parts of a stage, or something beside the stages?

**Assumed to proceed (not an answer):** testing is a stage. Performance
validation, UX design, UX validation and accessibility do not appear at all.

**Bears on it:** design record §1 lists them as runs the pipeline spawns, and
says testing, accessibility validation, UX validation and performance
validation are "not mandatory"; point 5 and [open questions B1](../unfiled/2026-09-20-open-questions.md#b1-which-settings-are-per-project-and-which-are-per-task).

**Where the mock depends on it:** `board.stages`.

### D-13. Is the vision grill, when the vision is empty, a stage of its own?

**Assumed to proceed (not an answer):** it does not appear. The Vision stage
stands for whatever happens at the vision.

**Bears on it:** design record §1, "If the vision is empty, start a small
grill on the vision", and point 3.

**Nowhere in the mock**, beyond its absence from the stage list.

### D-14. Does amending a standing artifact appear on the board?

**Assumed to proceed (not an answer):** no. The board shows only work that
builds something. Point 1 of the design record makes amending a separate
operation from executing, and the mock shows no amendments.

**Bears on it:** design record, point 1.

**Nowhere in the mock.**

### D-15. Can an item move back to an earlier stage?

**Assumed to proceed (not an answer):** no. Stages only move forward in the
mock.

**Bears on it:** design record, point 6. A blocker can be routed back
upstream, "move upstream" after a few tries. Whether the board shows that as
the item moving backwards, as a stop, or not at all, is not stated.

**Where the mock depends on it:** the advance rule only moves forward.

---

## C. States and stops

### D-16. What states does an item have?

**Assumed to proceed (not an answer):** two, *moving* and *stopped*. There is
no queued, not-started, done, failed, cancelled or paused.

**Bears on it:** the board statement ("stopping only when…"), which implies
stopped and not-stopped and names nothing else.

**Where the mock depends on it:** the `item.motion` field, marked
*interpreted*.

### D-17. What makes an item stop?

**Assumed to proceed (not an answer):** three reasons.

- `stage-complete`: the stage is done and the item is set to stop for the
  user, so it waits to be sent on.
- `has-something-to-raise`
- `needs-user`

**Bears on it:** the board statement names two occasions in one sentence: "when
they have something to raise or the user is needed somewhere". Treating those
as two categories is a reading. The third reason is implied by being able to
send items on by hand rather than automatically, and is not stated. The names
are the mock's.

**Where the mock depends on it:** `stop.category` and `item.stop`, marked
*interpreted*.

### D-18. What does "the user is needed somewhere" mean concretely, and how does it differ from "something to raise"?

**Assumed to proceed (not an answer):** *has something to raise* is a
question the item is putting to the user, such as an upstream artifact that
does not settle what this task needs. *Needs the user* is a blocker the
orchestrator cannot get past, where the user is asked to go into a layer and
act there. The sample items follow that split. Nothing records it.

**Bears on it:** VISION.md's position that a dependent vertical "should flag
rather than improvise"; design record, point 6 ("It will be a blocker handled
by the orchestration"); and §3, where a blocked task has the orchestrator ask
the user "to go into the right layer".

**Where the mock depends on it:** the sample stops on `item-2` and `item-3`.

### D-19. What does a stop tell the user beyond its reason?

**Assumed to proceed (not an answer):** one sentence. It carries no link to
the layer, the artifact, the decision in question or the conversation that
raised it.

**Where the mock depends on it:** the `stop.detail` field.

### D-20. Where does the user answer what an item raised, or do what it needs?

**Assumed to proceed (not an answer):** not on this board. The board has two
actions, and neither of them answers anything. So an item stopped for either
of those reasons stays stopped for as long as the mock runs.

This is the largest gap the mockup shows. Stopping for the user is the point
of the board, and the board offers nothing to do once it has stopped.

**Bears on it:** design record §3, where the orchestrator "asks the user to go
into the right layer, and asks them what to do".

**Where the mock depends on it:** the advance rule refuses these items.

### D-21. Does the board show what is happening inside a moving item?

**Assumed to proceed (not an answer):** no. It shows no progress, no current
run, no clarification retries between layers and no elapsed time. The mock
also has nothing to show: nothing runs, so a moving item never changes.

**Bears on it:** design record, point 6 (retries between layers);
[open questions B2](../unfiled/2026-09-20-open-questions.md#b2-the-loopback-retry-count).

**Nowhere in the mock.**

### D-22. Does anything tell the user when an item stops, or is the board only somewhere to look?

**Assumed to proceed (not an answer):** only somewhere to look. There are no
notifications.

**Bears on it:** the board statement, where items stop "only when they have
something to raise or the user is needed somewhere". Being needed implies
being reached, and the statement does not say how.

**Nowhere in the mock.**

### D-23. Does the board show that an item went stale because another item amended something upstream?

**Assumed to proceed (not an answer):** no.

**Bears on it:** design record, point 1. Two tasks are in flight, one amends
the vision, "and the other is already derived from the old version with
nothing marking it stale".

**Nowhere in the mock.**

---

## D. Advancing

### D-24. When may the user advance an item?

**Assumed to proceed (not an answer):** only when it is stopped at a completed
stage, and not at the last stage. The mock refuses to advance an item that is
moving, which would mean skipping the rest of its stage. It also refuses one
that has something to raise or needs the user, which would mean overriding
it.

**Bears on it:** the board statement: items "can be sent to the next stage or
sent automatically". It gives no condition.

**Where the mock depends on it:** the `item.advanceable` field and the
refusals from `POST /api/items/:id/advance`.

### D-25. What does advancing do when the next stage is delegated rather than pinned?

**Assumed to proceed (not an answer):** the mock does not model delegation or
pins, so every stage behaves the same.

**Bears on it:** VISION.md, "Delegation as a dial" and "Granularity of the
dial" ("delegate a vertical by default and pin specific decisions I care
about");
[open questions C3](../unfiled/2026-09-20-open-questions.md#c3-delegation-dial-semantics).

**Nowhere in the mock**, which is itself the assumption.

### D-26. What state is an item in right after it is advanced?

**Assumed to proceed (not an answer):** moving, in its new stage, with no
stop. Nothing runs in the mock, so it then stays moving until the server
restarts.

**Where the mock depends on it:** the advance action in
`mock-server/src/rules.ts`.

---

## E. Advancing automatically, or stopping for the user

### D-27. Is the automatic / stop-for-user setting the delegation dial, or a separate control?

**Assumed to proceed (not an answer):** separate. It decides only whether a
finished stage sends the item on by itself. It says nothing about who decides
anything inside a stage.

**Bears on it:** VISION.md, "Delegation as a dial"; the board statement,
"sent to the next stage or sent automatically".

**Where the mock depends on it:** `item.advanceMode` has no link to anything
else.

### D-28. At what grain is that setting chosen?

**Assumed to proceed (not an answer):** per item. It could instead be per
project, per stage, or per item per stage.

**Bears on it:** the board statement does not say. Design record, points 3
and 5, where some settings are per project and some per task;
[open questions B1](../unfiled/2026-09-20-open-questions.md#b1-which-settings-are-per-project-and-which-are-per-task).

**Where the mock depends on it:** the `item.advanceMode` field, marked
*interpreted*.

### D-29. What is the setting for new work, before the user touches it?

**Assumed to proceed (not an answer):** no default exists, because nothing
creates work (D-06). The sample items use both values.

**Nowhere in the mock.**

### D-30. Does switching an item to automatic send it on at once if it is already waiting at a completed stage?

**Assumed to proceed (not an answer):** no. The mock records the setting and
changes nothing else. So an item can be *automatic* and still waiting at a
completed stage, which the real thing presumably would not allow.

**Where the mock depends on it:** the advance-mode action in
`mock-server/src/rules.ts`.

### D-31. Does switching a moving item to stop-for-user take effect now or at the end of its stage?

**Assumed to proceed (not an answer):** it is only recorded. Since nothing
moves in the mock, the question never comes up there.

**Nowhere in the mock.**

### D-32. Does *automatic* apply at the stages where the user wants a say?

**Assumed to proceed (not an answer):** yes, like any other stage. An
automatic item would pass Vision, Decisions and Architecture without stopping
unless it had something to raise.

**Bears on it:** design record §1: "For vision, decisions, and architecture —
at least the early layers — the user wants some say in what is going on."
Also point 6, where the main project artifacts "should always require a
decision".

**Nowhere in the mock**, because nothing advances automatically in it.

---

## F. Where things live

### D-33. Where does Entail's orchestrator run?

**Not assumed.** This mockup has an HTTP mock server because the UI needs
something to fetch from. That does not make the orchestrator a server, a
long-running process, a CLI, a library or a skill.

**Bears on it:**
[open questions C2](../unfiled/2026-09-20-open-questions.md#c2-where-the-orchestrator-runs).

**Nowhere in the mock.**

### D-34. What language is the orchestrator written in?

**Not assumed.** TypeScript was chosen for this UI and this mock server only.
Nothing about the two packages' layout or language is meant to extend to the
orchestrator.

**Nowhere in the mock.**

### D-35. Where does the board's state live, and what is its source of truth?

**Assumed to proceed (not an answer):** the mock server's memory. It resets on
restart, and nothing the user does persists. The real board could be derived
from artifacts in the repository, keep a store of its own, or read the
orchestrator's state.

**Bears on it:** VISION.md, "Constraints I'm accepting" (local-first, artifacts
as files in the repo); open questions C4.

**Where the mock depends on it:** `mock-server/src/server.ts` holds items in
memory.

### D-36. How does the board learn that something changed?

**Assumed to proceed (not an answer):** it does not learn by itself. It
fetches the board when it loads and after each of its own actions. There is
no polling and no push. The mock has no change from elsewhere to learn about
anyway.

**Where the mock depends on it:** the UI fetches the board when it loads and
again after each action. It has no refresh button.

### D-37. Is this HTTP API a draft of a real interface?

**Assumed to proceed (not an answer):** no. It exists so the UI's state has
one reviewable home. Its routes, shapes and names are the mockup's.

**Where the mock depends on it:** `mock-server/src/contract.ts`.

### D-38. What surface is the real board: a web page, a terminal view, part of an editor?

**Assumed to proceed (not an answer):** a web page, because this mockup was
asked for in React. That is a choice about the mockup, not about the product.

**Bears on it:** open questions C2 names the board as part of the product,
and VISION.md's "nothing hosted".

**Nowhere in the mock server.**

---

## G. Words and marking

### D-39. What does Entail call these things?

**Assumed to proceed (not an answer):** the words are the mock's own. They
are *item*, *stage* and each stage's name, *moving* and *stopped*, *stage
complete*, *has something to raise*, *needs user*, *advance*, *automatic* and
*stop for user*. The only recorded words among them are "stage", "sent to the
next stage", "sent automatically", "something to raise" and "the user is
needed".

**Where the mock depends on it:** every name in
`mock-server/src/contract.ts`, the `stage.name` field, and every word in
`board.labels`. A label made from recorded words is marked *interpreted*, never
*recorded*: the words are recorded, their use as that label is not.

### D-40. Does the real board show provenance, or is that a device of this mockup?

**Assumed to proceed (not an answer):** it is a device of this mockup. The
mockup marks where each value came from so that what is drawn cannot pass as
decided. Whether Entail's own board should show which parts came from the
user and which a layer produced is a separate question.

**Bears on it:** [build philosophy §3](../unfiled/2026-09-20-build-philosophy.md#3-raised-and-not-settled),
where the captain raised a separation between what the user gave and what a
layer produced, "Maybe."

**Where the mock depends on it:** all of `mock-server/src/provenance.ts`.

---

## H. Raised by drawing the board

### D-41. Where does the board end and the mockup around it begin?

**Assumed to proceed (not an answer):** everything that depicts the board is
served with provenance, with no exceptions: headings, column names, state
words, the action's label, and glyphs such as the arrow between stages, the
colon after a heading and the dash for an item with no stop. The UI writes no
text or glyph on the board itself. Text that describes the mockup is written
in the UI and carries no provenance. That covers the banner, the legend, the
inspector and the error shown when the mock server is down. The UI draws that frame visibly apart
from the board, so none of its text can be read as part of Entail's design.

The line is drawn by what the text depicts, not by how important it seems.
The captain's rule is that provenance goes on every single detail, so nothing
on the board is exempt, however small. The frame is not part of the board, and
this entry is here so that line is stated rather than silent.

**Where the mock depends on it:** `board.labels`, and the frame in
`ui/src/App.tsx`.

### D-42. What does a stopped item look like next to a moving one?

**Assumed to proceed (not an answer):** the same row, carrying the word
*stopped* and the reason. It is not sorted to the top, gets no colour, gets
no separate section and no count. An item that needs the user looks like any
other stopped item except for its words.

**Bears on it:** the board statement; items stop "only when they have
something to raise or the user is needed somewhere", which gives those items
a reason to stand out and does not say how.

**Where the mock depends on it:** the UI's table.

### D-43. What does the user see after sending an item on or changing its setting?

**Assumed to proceed (not an answer):** the row simply shows the new state.
The changed value is marked as set by the user. There is no confirmation
message, no animation and no record of the change elsewhere.

**Where the mock depends on it:** the UI refetches the board after each
action (D-36).

### D-44. Is sending an item on confirmed first, and can it be undone?

**Assumed to proceed (not an answer):** no to both. One click sends it on, and
nothing takes it back.

**Nowhere in the mock**, beyond the absence of both.

### D-45. How is an action that is not available shown?

**Assumed to proceed (not an answer):** the button stays where it is, under
the item's stage, but is disabled and reads *cannot be sent on now*. Pointing
at it shows the server's reason for that item. The button is not hidden.

**Where the mock depends on it:** the `item.advanceable` field.

### D-46. Where is the automatic / stop setting, and how is it presented?

**Assumed to proceed (not an answer):** on each row, as a choice between two
options under the heading *When its stage is done*. Both options are always
visible and the current one is selected.

**Where the mock depends on it:** the UI's table, and D-28.

### D-47. Does each item show the whole sequence of stages, or only its own?

**Assumed to proceed (not an answer):** only its own stage's name. The
sequence is shown once above the table.

**Where the mock depends on it:** the UI's layout (D-09).

### D-48. What does the board show when it cannot reach whatever serves it?

**Assumed to proceed (not an answer):** no board. It shows a message, in the
mockup's frame, saying the mock server is not reachable and how to start it.
What the real board would show if the orchestrator were unreachable is open,
and depends on D-33.

**Where the mock depends on it:** the UI's load error.

### D-49. Which things that boards usually have does this one need?

**Assumed to proceed (not an answer):** none of them. The board has no
filtering, search, sorting controls, grouping, counts or summaries, item
detail view, history, comments, assignees, due dates, priorities, bulk
actions, way to add or remove items, refresh button, live updates,
notifications, settings, sign-in or theming. Each was left out because the
core loop does not need it. Nothing records that the board should have any of
them. Any that turns out to be wanted is its own question.

**Nowhere in the mock**, which is the assumption.

### D-50. How do the user's own changes rank against recorded, interpreted, assumed and placeholder?

**Assumed to proceed (not an answer):** they are not on that ladder. A thing
on the board that answers several questions is marked by the weakest
provenance among its parts, ranked recorded, then interpreted, then assumed,
then placeholder, so it can show as recorded only if every part is recorded.
A value the user changed through one of the two actions is marked *set by
you* whatever its other parts are. Only the value itself can make a thing
*set by you*: why its field exists, or the words used to show it, never do.
Whether a user's change should outrank, rank below, or sit beside what is
recorded is open, and so is whether the real board marks it at all (D-40).

**Where the mock depends on it:** how each target is marked, in
`ui/src/targets.ts`.
