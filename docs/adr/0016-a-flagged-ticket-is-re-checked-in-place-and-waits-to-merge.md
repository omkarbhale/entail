# A flagged ticket is re-checked in place, and nothing merges until the re-check is recorded

When a vision change flags a cleared or landing ticket, the ticket keeps its state and its `entail:cleared` label, so an executor keeps working. entail runs a **re-check**: one read-only decider run at the new vision sha. It is given the prior call (its citation, vision check and reading chosen) and the lines the change removed and added, and it answers one narrow question: does this change alter that call? No PR for the ticket merges until the re-check call is recorded. VISION.md says a vision change flags in-flight work that relied on the old text, and that a large rework or significant drift never happens unasked. The narrow question keeps model noise from reopening what the change did not touch, which is why re-deciding every in-flight ticket was rejected on [How are vision lines identified and their origins kept outside the prose?](https://github.com/omkarbhale/entail/issues/20).

## Which tickets are flagged

This amends the rule decided on [How are vision lines identified and their origins kept outside the prose?](https://github.com/omkarbhale/entail/issues/20). A cleared or landing ticket whose clear came from an automatic verdict, settled or unopposed, is flagged when:
- **any line is added**; or
- **a line its call cites is removed**.

A reworded line is one removed and one added. Since ADR-0011, both verdicts pass the same step (no line contradicts the ticket, and its readings are not consequential) before the readings step, so a new line can overturn either one. The earlier rule flagged a settled ticket only when its cited line went, and missed a new line that contradicts it.

Unchanged from #20: tickets in a final state are never flagged; a deciding ticket reruns at the new sha; an investigating ticket is decided at whatever vision is current when its findings arrive; an open board item is withdrawn and its ticket decided again (ADR-0008).

## Outcomes

Each re-check is a logged call with one of three outcomes:

1. **Stands.** The change does not alter the call. If the cited line was reworded, the call carries the new citation. The criteria version is kept when every criterion's source still exists at the new sha and the reading chosen is the same. Otherwise a new criteria version is written by the separate criteria run (ADR-0005).
2. **Goes ahead differently.** The new vision settles the ticket on another reading, with a new citation, or a cited line vanished and the ticket is now unopposed with no consequential readings. A new criteria version is written, and the ticket stays cleared or landing.
3. **Needs the owner.** An added line contradicts the ticket or makes its readings consequential, or a removed cited line leaves readings that the vision no longer chooses between. The ticket goes on the board, `entail:cleared` is removed (ADR-0013), and no PR for it merges.

Outcomes 1 and 2 keep a ticket going ahead without the owner. They therefore pass the same mechanical checks and the same challenge as any automatic verdict (ADR-0002, ADR-0011). A failed check or a successful challenge turns the outcome into 3. entail never cancels or closes a flagged ticket on its own, because closing on the vision alone is never allowed (ADR-0006). Outcome 2 changes an executor's target mid-work without asking the owner. That is accepted because the owner's own vision edit caused it.

Settled and unopposed tickets are handled the same way once flagged.

## What the executor and the open PR see

- **The issue.** entail posts a new intake comment (ADR-0007), naming the comment it replaces and the vision change's sha, only when the re-check changed something an executor reads: the vision check's bearing lines or marks, the citation, the criteria version or the state. A re-check that changes none of these posts nothing on the issue, and its call is on the Calls page.
- **The landing check's trigger.** A landing check runs once for each distinct head sha, latest evidence section and **criteria version**. A new criteria version therefore triggers a fresh landing check against it, and a new id with no evidence is not met (ADR-0013).
- **A landing check in progress** when the flag lands finishes, but it posts and merges nothing until the re-check is recorded. If the criteria version is unchanged, its result is used as is, with no extra model runs. The forge's state is then verified live, and the landing comment is posted and the PR merged as usual.
- **No comment for the hold itself.** The re-check takes minutes, and a landing check never comments while it waits, just as with pending checks. Machine failures retry as everywhere else (ADR-0002), and the merge stays held meanwhile.
- **Going to the board.** If the ticket goes on the board, each open PR for it gets one comment: its issue was raised to the owner after a vision change, and it will not merge unless the owner's answer lets it go ahead.
  - The owner's "go ahead" writes a new criteria version, and the PR is checked again.
  - "Don't go ahead" cancels the ticket. The PR gets one comment saying so but is not closed, since closing PRs is a later effort.
- **The merge guard.** Just before merging, entail reads VISION.md's blob on the default branch again (ADR-0013 point 8). This is one cheap request, an ETag hit on GitHub. If it changed since the last poll, entail processes that vision change first and merges only if this ticket was not flagged by it. This closes the race between a passing landing check and a vision edit.
- **Several vision changes.** If another vision change arrives before a re-check is recorded, the re-check restarts at the newest sha, with the lines removed and added across both.

## Tickets the owner already answered

A ticket cleared because the owner answered its board item "go ahead" has no automatic verdict, and it is **not flagged** (owner). Answers are final (ADR-0008), and the owner made both the answer and the vision edit. To stop such a ticket, the owner closes its issue, which cancels it. Its criteria keep any vision constraint they quoted.

## How the owner learns what a re-check did

Each re-check is a call, so the Calls page (ADR-0009) shows it, and it can filter to one vision change, listing every ticket that change flagged and each outcome (owner). Only an outcome that needs the owner reaches the board, with the usual notice. No other notice or summary is sent.

## Considered options

- **Re-decide in full**: the ticket goes back to deciding, its label is removed, and the decider and the criteria run from scratch at the new sha. Rejected. It is the churn #20 rejected, and it would strip and re-add the label on tickets the change barely touched.
- **Raise every flagged ticket to the owner**: rejected. Most vision edits change no in-flight call, and the board would fill with questions the vision already answers.
- **Note the change on the issue and carry on**: rejected. A ticket that the new vision contradicts could then merge automatically.
- **Move a flagged ticket to a state of its own**, which removes the label while the re-check runs: rejected. The label would flicker on every vision edit, and ADR-0013 lets an executor trust the label alone.
- **Post a new intake comment after every re-check**, as ADR-0007 does after every decision: rejected. It is noise on every issue each time the owner adds a line elsewhere.
- **Flag tickets the owner answered too**: rejected by the owner. It would re-ask the owner about their own decision because of their own edit.
- **A desktop notice summarising each vision change's re-checks**: passed over by the owner. Notices stay for items that need the owner.
- **A board entry per vision change**: rejected. It is not a product decision, and VISION.md resists non-decision traffic on the board.

## Consequences

- **Cost.** In practice, most vision edits that add a line re-check every in-flight automatic ticket in that repo. Each re-check costs one decider run plus one challenge, and a criteria run when the criteria change.
- **ADR-0007** is narrowed: a re-check that changes nothing an executor reads posts no intake comment.
- **ADR-0014**'s trigger gains the criteria version.
- **The acceptance test** (ADR-0010) gains no vision change. Re-checks are covered by unit tests of the flag lookup, the merge guard, the landing trigger and each outcome, as self-hosted GitLab and the `/entail` rule are. A vision edit in the middle of the 3-run test would make its expected outcomes depend on model judgment about the edit too.
- Decided on [What does a vision change do to a flagged ticket that is already cleared or landing?](https://github.com/omkarbhale/entail/issues/37).
