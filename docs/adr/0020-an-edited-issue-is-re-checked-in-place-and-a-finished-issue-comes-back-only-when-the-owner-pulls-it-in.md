# An edited issue is re-checked in place, and a finished issue comes back only when the owner pulls it in

An issue can change after entail has taken it in: its title or body is edited, `/entail` is posted on it again, or it is reopened after its ticket ended. entail treats an edit to a cleared or landing issue the way it treats a vision change (ADR-0016). It **re-checks the ticket in place** and holds its merge until the re-check is recorded (owner). A finished issue comes back only when the owner **pulls it in** with `/entail`, and it comes back as a **new ticket** linked to the one before (owner). Reopening an issue alone does nothing.

VISION.md says a large rework or significant drift never happens unasked. Criteria were frozen against the text the decider judged, so a changed request must not merge unjudged, and an owner's own clarification should not be silently ignored. Agents act under the owner's login and anyone with triage rights can reopen an issue, so a reopen cannot be the owner's word (ADR-0001). Pulling in is already the one deliberate way an issue enters, so it is also how an issue comes back.

## What counts as an issue edit

An issue edit is a change to the issue's **title or body**, compared with the text the ticket's latest call recorded (ADR-0009).
- Changes to whitespace only are ignored, and so is ticking or unticking a task-list checkbox, which is progress rather than a different request.
- New comments (other than `/entail` and findings), labels, assignees and milestones are not edits. Comments are not what the decider judges.
- Who edited does not matter. Issue text is never the owner's word (ADR-0001), so an edit by the reporter, the owner or an agent is the same changed request.

## An edit in each state

- **Deciding.** The run in flight is discarded and the ticket is decided at the latest text, as a deciding ticket reruns at a new vision (ADR-0016). No intake comment has been posted yet.
- **Investigating.** Nothing happens until findings arrive. The ticket is then decided at the text current at that point. The investigation's questions stand.
- **On the board.** The open item is withdrawn and the ticket decided again (ADR-0008), because the item's options were written for the old text. The form locks and says the issue was edited (ADR-0012).
- **Cleared or landing.** The ticket is flagged and re-checked in place (owner):
  - It keeps its state and `entail:cleared`, so an executor keeps working.
  - One decider run gets the prior call and the old and new text, and answers only whether the edit alters that call. It stands, goes ahead differently with a new criteria version, or needs the owner. These are ADR-0016's three outcomes, with the same mechanical checks and challenge.
  - Nothing for the ticket merges until the re-check is recorded. Just before merging, entail re-reads the issue's title and body, as it re-reads VISION.md (ADR-0016).
  - Another edit or a vision change before the re-check is recorded restarts it with every change so far.
  - A new intake comment is posted only when something an executor reads changed. A new criteria version triggers a fresh landing check (ADR-0016).
- **Cleared by the owner's answer** (owner). Unlike a vision change, an edit re-checks these tickets too, because the edit may be anyone's. The answer stands as given: the re-check cannot reopen it and can only find a product call the answer does not cover. That call goes to the board as a new item for that call alone (ADR-0008). Otherwise the ticket stands, or it gets a new criteria version that still cites the answer.
- **Final** (merged, cancelled, declined). Nothing happens.

## `/entail` and reopened issues

- **The comment.** A `/entail` counts when a newly posted comment by the owner's account, matched by numeric id (ADR-0015), has `/entail` as its whole first line. Text after that line is ignored. Editing an old comment to add it does not count, and each comment counts once, by its forge id.
- **On a ticket in flight**, it does nothing and nothing is posted (owner). The intake comment already says where the ticket stands.
- **On a closed issue**, it does nothing, and entail replies once that it takes in only open issues: reopen the issue and pull it in again (owner).
- **From anyone else**, it does nothing and nothing is posted (owner).
- **On an open issue whose last ticket is final** (cancelled, declined or merged), it pulls the issue in again (owner). Only a `/entail` posted after that final call counts, so an old comment never re-triggers intake after a restart or a re-scan.
- **Reopening an issue** pulls nothing in, whoever reopened it (owner).

## A finished issue comes back as a new ticket

Each time an issue is pulled in again, it gets a new ticket, linked to its predecessor, and the predecessor stays final. An issue therefore has at most one ticket in flight.
- The new ticket is taken in fresh: size check, verdict and criteria at the current text and the current vision.
- If it reaches the board, the item's "what happened" lists the predecessor's calls and any answer, so the owner sees they answered it before. That answer does not settle the new ticket, because an answer settles only its own ticket (ADR-0008).
- Its first intake comment names the predecessor's last one (ADR-0007).

## Issues that vanish, move, or close and reopen unseen

- An issue that is deleted, transferred to another repo, or converted to a GitHub discussion is treated as closed elsewhere. Its ticket is cancelled, as in any non-final state, and any open board item is withdrawn.
- An issue transferred into an enrolled repo is not the owner's new issue there. It enters only by being pulled in.
- entail acts on the state it reads on each pass. An issue closed and reopened between two passes, whose close entail never saw, cancels nothing.

## Considered options

- **Ignore an edit to a cleared issue, since its criteria are frozen**: passed over by the owner. It is cheap and predictable, but the owner's own clarification would do nothing, and the issue would no longer say what gets built.
- **Send an edited cleared issue back to deciding**: rejected. The label would flicker and an executor's work would be stranded on every typo fix, the churn ADR-0016 rejected for vision changes.
- **Leave tickets cleared by the owner's answer alone on an edit**, as for vision changes: passed over by the owner. The vision-change exemption rests on the owner making both the answer and the edit, which is not true of an issue edit.
- **Count new comments as edits**: rejected. Every discussion would trigger a re-check, and comments are not decider input.
- **Bring an issue back when the owner's account reopens it**: passed over by the owner. An agent reopening an issue under the owner's login would silently restart intake.
- **Never bring a finished issue back**: passed over by the owner. The owner would have to file a new issue and lose the old thread.
- **Reply to every `/entail` that does nothing, or to none**: passed over by the owner. Replying to everyone adds noise on public repos and tells strangers how to steer entail, and never replying leaves the owner guessing on a closed issue.
- **Revive the same ticket from its final state**: rejected. "Final" would no longer mean final, and one ticket would carry two rounds of verdicts, criteria and answers in its audit trail.
- **Keep an open board item and refresh its quoted issue after an edit**: rejected, because its options were written for the old text.

## Consequences

- **ADR-0016** gains a second trigger. An issue edit flags a cleared or landing ticket, including one cleared by the owner's answer, and the merge guard re-reads the issue's text as well as VISION.md.
- **ADR-0008**'s open question about reopening a cancelled issue is answered: the owner pulls it in again, as a new ticket.
- **ADR-0009**: the records link a ticket to its predecessor, and each call already keeps the title and body it judged, which is what an edit is compared with.
- **Cost.** Each edit to a cleared or landing issue costs one decider run and one challenge, plus a criteria run when the criteria change.
- **The acceptance test** (ADR-0010) gains no edit or reopen. Like re-checks after a vision change, these rules are covered by unit tests: the edit comparison, each state's outcome, the merge guard's issue re-read, the `/entail` rules and the new-ticket link.
- Decided on [What happens to an issue that is edited, pulled in again or reopened after intake?](https://github.com/omkarbhale/entail/issues/52).
