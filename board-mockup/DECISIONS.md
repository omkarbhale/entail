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

**Assumed to proceed (not an answer):** see D-58, which replaced the
assumption first taken here. The board now has one way to start work: somebody
describes it. The sample items are still seeded when the server starts.

**Bears on it:** design record §1, "Somebody arrives and describes some task…
That goes into a pipeline and follows it."

**Where the mock depends on it:** the seed list in
`mock-server/src/fiction.ts`, and D-58.

### D-07. What happens when an item finishes its last stage?

**Assumed to proceed (not an answer):** see D-60, which replaced the
assumption first taken here that nothing may happen. Nothing recorded says
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

**Assumed to proceed (not an answer):** three, *moving*, *stopped* and
*landed*. *Landed* was added with completion (D-60). There is no queued,
not-started, failed, cancelled or paused.

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

**Assumed to proceed (not an answer):** see D-52, which replaced the
assumption first taken here. The first version of this mockup offered nothing
to do once an item stopped for the user. It now hands over what an agent needs
to answer it through Entail's imagined MCP. The board still does not take an
answer itself.

**Bears on it:** design record §3, where the orchestrator "asks the user to go
into the right layer, and asks them what to do".

**Where the mock depends on it:** the advance rule refuses these items, and
D-52.

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
stage. At the last stage that lands it (D-60). The mock refuses to advance an
item that is moving, which would mean skipping the rest of its stage. It also
refuses one that has something to raise or needs the user, which would mean
overriding it, and one that has landed.

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

**Assumed to proceed (not an answer):** see D-59, which replaced the
assumption first taken here that no default exists. The sample items use both
values.

**Where the mock depends on it:** D-59.

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
needed". The words added with answering, creating work and completion
(D-51 to D-61) are the mock's too, except "describes some task, feature",
"goes into a pipeline", "the final pull request" and "what the user gave",
which are recorded words used as labels.

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
actions, way to remove items, refresh button, live updates,
notifications, settings, sign-in or theming. Each was left out because the
core loop does not need it. A way to add items was since added (D-58); what
the three later additions left out is listed in D-64. Nothing records that the
board should have any of them. Any that turns out to be wanted is its own
question.

**Nowhere in the mock**, which is the assumption.

### D-50. How do the user's own changes rank against recorded, interpreted, assumed and placeholder?

**Assumed to proceed (not an answer):** they are not on that ladder. A thing
on the board that answers several questions is marked by the weakest
provenance among its parts, ranked recorded, then interpreted, then assumed,
then placeholder, so it can show as recorded only if every part is recorded.
A value the user set through one of the board's actions, or an answer whose
words they stated (D-56), is marked *set by you* whatever its other parts
are. Only the value itself can make a thing
*set by you*: why its field exists, or the words used to show it, never do.
Whether a user's change should outrank, rank below, or sit beside what is
recorded is open, and so is whether the real board marks it at all (D-40).

A value an agent composed and the user agreed to (D-56) is off the ladder too,
and is marked *agreed by you*, never *set by you*. The same rule applies: only
the value itself can make a thing *agreed by you*. A thing whose value is set
by the user shows as *set by you* even if a part of it was agreed to.

**Where the mock depends on it:** how each target is marked, in
`ui/src/targets.ts`.

---

## I. Raised by adding answering, creating work and completion

The captain described how the flow is imagined to work, when asking for these
three additions: advancing is imagined to spawn agents in tmux, the way
firstmate does, and answering what an item raises is imagined to go through an
MCP that Entail exposes, which any agent (the user's own or another) can be
asked to use, with Entail's MCP telling the agent what to do. He said both are
how it is imagined, not how it has been decided. Those words are in the
request for this change, not in `VISION.md` or `unfiled/`, so nothing on the
board can cite them. Every entry below that leans on them is an assumption.

### D-51. What does advancing an item mean?

**Assumed to proceed (not an answer):** it spawns an agent for the item's new
stage, in a tmux pane of its own. The board shows that only as a pane name on
a moving item, `entail:<item>.<stage>`, beside the words *agent at work in
tmux pane*. The mock spawns nothing, runs no tmux command, launches no
process and shells out to nothing. The pane name is invented, and so is its
form.

Also assumed: an item going back into motion after an answer (D-57) is shown
in the same pane name, as though its stage's agent carried on. Whether it is
the same agent, a new one, or no agent at all is open. So is whether a pane
outlives its stage, whether an item has one pane or one per stage, and who
closes it.

**Bears on it:** the captain's description of how the flow is imagined
(introduction to this section). Nothing recorded.

**Where the mock depends on it:** the `item.agent` field, the `agent` label,
and `paneName` in `mock-server/src/rules.ts`.

### D-52. Where does the user answer what an item raised, or do what it needs?

**Assumed to proceed (not an answer):** through an agent, using an MCP that
Entail is imagined to expose. An item stopped because it *has something to
raise* or *needs the user* shows what it asks, and under it the board hands
over a ready-made invocation for the user to give an agent. The board does not
collect the answer. It shows and routes. This replaces the assumption in D-20,
which left these items with nothing to do.

The mock builds no MCP server, adds no MCP dependency and makes nothing an
agent could call. The tool named in the invocation, `entail_resolve`, does not
exist.

The same assumption covers both reasons for stopping (D-18), although only
the second is described in the record as sending the user into a layer. The
board treats "go into the right layer" as something the agent does with the
MCP's instructions, not something the user does by hand.

**Bears on it:** design record §3, where the orchestrator "asks the user to go
into the right layer, and asks them what to do"; the captain's description of
how resolution is imagined (introduction to this section).

**Where the mock depends on it:** the `stop.handover` field, the `handover`
label, the `raised` refusal in `mock-server/src/rules.ts`.

### D-53. What does the invocation the board hands over carry?

**Assumed to proceed (not an answer):** only what points at the thing: the
item's id and title, the stage it stopped at, what it asks, a pending id that
names this one thing to be resolved, and the tool's name. It says to ask the
MCP about that pending id and do what the MCP says. It does not carry the
artifacts, the upstream decisions, the conversation that raised it or any
instructions for how to answer. Those are imagined to come from Entail's MCP,
which is what keeps the flow's integrity, so the user does not have to
reconstruct them and the agent does not get to choose them.

The pending id's form, `<item>/q<n>`, and the invocation's wording are the
mock's. Whether the handover is words for a person to paste, a structured
call, a link or something else is open. So is whether an item can have more
than one thing pending at once; in the mock it cannot.

**Where the mock depends on it:** the `handover` record, built in
`mock-server/src/fiction.ts`.

### D-54. Does exposing an MCP mean Entail's orchestrator is a long-running process?

**Not assumed.** An MCP that agents call implies something running to answer
them, rather than a CLI invoked per command. That would bear on D-33 and on
[open questions C2](../unfiled/2026-09-20-open-questions.md#c2-where-the-orchestrator-runs),
which is open. The mock does not decide it. Its HTTP route standing in for the
tool (D-55) lives in the mock server only because the UI needed something to
fetch from, and says nothing about where the orchestrator runs. An MCP server
started per session by the agent, or one that reads and writes files in the
repository and exits, would also fit; nothing here chooses between them.

**Nowhere in the mock.**

### D-55. How does an answer enter, in this mock?

**Assumed to proceed (not an answer):** through one route only,
`POST /api/resolutions`, which stands in for the one write the imagined MCP
tool would make. It is the single writer: nothing else can record an answer,
and the board has no field, button or form for one. Two paths would drift.
The route refuses an answer for an item that is not waiting on one, and for a
pending id that is not the one the item is waiting on, so an answer cannot
land on the wrong question or be given twice.

The board never calls this route. The mockup's frame does, in a panel drawn
outside the board that plays the part of the agent, so the loop can be seen
end to end in a browser. That panel is the mockup standing in for an agent,
not a design for anything Entail shows (D-41).

**Where the mock depends on it:** the `/api/resolutions` route in
`mock-server/src/server.ts`, `resolve` in `mock-server/src/rules.ts`, and the
agent panel in `ui/src/AgentStandIn.tsx`.

### D-56. Is an answer the user stated the same as one an agent composed and the user agreed to?

**Assumed to proceed (not an answer):** no, and they are never recorded as
each other. Both arrive through an agent. An answer the user stated, whose
words the agent passed on unchanged, has origin `stated-by-user`. An answer
an agent composed and the user agreed to has origin `composed-by-agent`.
Recording the second as the first would be the leakage Entail exists to
prevent: a decision the user never made reading as theirs.

The distinction is carried twice. In what Entail would record, as the
answer's `origin` field, shown on the board as *you said this* or *an agent
proposed this, and you agreed*. And in this mockup's provenance vocabulary,
which gains a sixth kind, `agent-composed`, beside `user-input`. The
existing `user-input` kind could not carry it: it is what the board marks
*set by you*, and an agreement is not that. An `agent-composed` value is
marked on its own, as *agreed by you*, never as *set by you*, and like
`user-input` it is off the ladder of D-50.

Also assumed: the agent says which it was, and the tool requires it to say;
there is no default. Nothing checks the agent's claim. Whether Entail should
verify it, default to the weaker claim when unsure, keep the words the user
agreed to separately from the words the user said, or record an edit by the
user to a composed answer as a third origin, is open. So is whether a user
can reject a composed answer and what that records.

**Bears on it:**
[build philosophy §3](../unfiled/2026-09-20-build-philosophy.md#3-raised-and-not-settled):
"There should probably be separation between what the user gave and what a
layer produced", raised and not ruled on, "Maybe."; D-40.

**Where the mock depends on it:** the `answer.origin` field, the
`agent-composed` kind in `mock-server/src/provenance.ts`, and how targets are
marked in `ui/src/targets.ts`.

### D-57. What happens to an item once what it asked is answered?

**Assumed to proceed (not an answer):** it goes back into motion in the same
stage, and is not sent on. The answer stays on the item, with what was asked,
as it was asked, and who the words came from. Nothing records whether an
answer should instead be routed upstream into an artifact, amend a layer, or
be re-checked before the item moves again.

**Bears on it:** design record, point 6, where a blocker can be routed
upstream; point 1, where amending is a separate operation from executing.

**Where the mock depends on it:** `resolve` in `mock-server/src/rules.ts`,
and the `item.answers` field.

### D-58. How does work get onto the board?

**Assumed to proceed (not an answer):** somebody describes a task or feature
in their own words, in one box at the top of the board, and it enters the
pipeline. This replaces the assumption in D-06. The words become the item's
title, trimmed and otherwise unchanged, which answers D-03 for new work only.
A description is refused if it is empty or longer than 2000 characters, a
limit that is the mock's. The new item starts at the first stage, already
moving, with an agent imagined in a pane for that stage (D-51), nothing
asked yet and no pull request.

Nothing else is asked when work is created: no kind (D-02), no project
(D-05), no choice of validations, no priority. The design record makes some
of those per-project settings, and asking for them at submission is what
point 5's critique warned against.

**Bears on it:** design record §1, "Somebody arrives and describes some task,
feature, activity, or a product to build. That goes into a pipeline and
follows it."; point 5.

**Where the mock depends on it:** `POST /api/items`, `describe` in
`mock-server/src/rules.ts`, and the `describe` and `submit` labels.

### D-59. What is the automatic / stop-for-user setting for new work?

**Assumed to proceed (not an answer):** *stop and wait for me*, until the
user changes it. This replaces the assumption in D-29, now that work can be
created. It follows the record's statement that the user wants some say in
the early layers, which is where new work starts. Nothing records a default.

**Bears on it:** design record §1, "For vision, decisions, and architecture —
at least the early layers — the user wants some say in what is going on."

**Where the mock depends on it:** `describe` in `mock-server/src/rules.ts`.

### D-60. What happens when an item finishes its last stage?

**Assumed to proceed (not an answer):** once its last stage is done and it is
waiting, sending it on lands it. The action's words change to *Land it*, and
the item takes a third state, *landed*, beside *moving* and *stopped*
(D-16). This replaces the assumption in D-07. A landed item cannot be sent on,
changed or reopened.

Nothing records what landing is: whether it is the pull request merging,
the user approving it, Entail noticing a merge made elsewhere, or something
else, or who merges. The mock merges nothing and opens no pull request. An
automatic item would presumably land by itself; nothing in the mock runs, so
the question does not come up there (D-32).

**Bears on it:** design record §1, "And so on, until the final pull request."

**Where the mock depends on it:** the advance rule and the `landed` state in
`mock-server/src/rules.ts`, and the `land` and `landed` labels.

### D-61. What is left behind when an item lands?

**Assumed to proceed (not an answer):** the item itself, in a list of landed
work under the items in flight; its pull request; and every answer it was
given along the way, each with what was asked and who the words came from.
That last part is the point of keeping it: once the work has landed, the
answers are what says which decisions in it were the user's and which were
agreed to.

Not shown, and open: which artifacts the item derived or amended, what
becomes of its per-task artifacts (open questions B6 and point 6's
per-task artifacts, which "can be volatile"), whether its branch or its agent's
pane is cleaned up, and whether a landed item ever leaves the board.

**Bears on it:** design record, point 6; open questions B6.

**Where the mock depends on it:** the `item.pullRequest` and `item.answers`
fields, and the landed list in `ui/src/BoardView.tsx`.

### D-62. Can the user answer on the board when no agent is at hand?

**Assumed to proceed (not an answer):** no. There is exactly one way for an
answer to enter (D-55), and it is through an agent. A form on the board would
be a second writer, and the two would drift: one would record origin and the
other would have to guess it. Whether the real product needs a way to answer
without an agent is open.

**Nowhere in the mock**, which is the assumption.

### D-63. Where does a landed item appear?

**Assumed to proceed (not an answer):** in its own list, headed *Landed*,
below the table of items in flight. The server serves one list of items and
the UI draws a landed item there rather than in the table; that split is by
the item's state and is the only thing the UI decides about where an item
goes.

**Where the mock depends on it:** `ui/src/BoardView.tsx`.

### D-64. Which things that a flow like this usually has does the board need?

**Assumed to proceed (not an answer):** none of them. Adding answering,
creating work and completion brought none of these with it: editing or
deleting work once created, attachments or links in a description, choosing
the starting stage, drafts, templates, a history or undo of answers, telling
the user when an answer has been recorded, showing which agent answered,
confirming a copy to the clipboard, reopening landed work, cleaning up after
it, or a count of what is pending. Each is left out because the flow does not
need it to be drawn. D-49 still holds for everything else.

**Nowhere in the mock**, which is the assumption.
