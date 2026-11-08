# An issue whose cause or validity is unknown is investigated before it gets criteria

When intake cannot tell whether an issue describes a real problem, or what causes it, entail does not clear it. It marks the issue for investigation with the label `entail:investigate`, used instead of `entail:cleared`, and posts a comment stating what the investigation must establish. Any executor picks it up the way it picks up a cleared issue and reports its findings as a comment on the issue, with no PR. entail then decides the ticket again from those findings:
- a real problem whose fix is now known gets its criteria and is cleared as usual;
- nothing to fix (it cannot be reproduced, the report is invalid, or it is already fixed) means entail closes the issue, with the reason logged;
- anything the vision cannot settle goes to the board.

The owner chose this because a report that is wrong, or whose cause is unknown, can never produce a PR that lands, and so could never close. An investigation therefore has to be an outcome of its own. VISION.md already lets entail close issues and cancel tickets as logged calls.

## Considered options

- **Investigate inside the executor's PR**: a criterion would require the PR to identify and explain the cause. Rejected by the owner, because an invalid or unreproducible report has no PR to land.
- **Send unknown problems to the board**: rejected. Whether a report reproduces is a fact for an executor to establish, not a product decision, and putting it on the board would carry work-management traffic there.

## Consequences

- **Investigating** is a ticket state, not a verdict: deciding → investigating → deciding. The decider may choose it after the size check, in place of a verdict, naming what must be established. That is a logged call with mechanical checks only (at least one question, no line starting with `/`), and no challenge, because an investigation changes nothing. Pins and the vision apply when the ticket is decided again.
- A ticket is investigated at most once. If the findings still leave the problem unknown, the ticket needs the owner.
- The findings are issue text: evidence to be judged, never the owner's word (ADR-0001). Closing on findings cites them as evidence and passes the same checks and challenge as any close at intake. Closing on the vision alone is never allowed: a request that contradicts the vision needs the owner.
- A PR that links an issue under investigation is not checked or merged. entail comments that the issue has no criteria yet.
- An issue closed by someone else while it is under investigation makes the ticket cancelled, as in any non-final state.
- `entail:investigate` and the findings comment are part of the label contract with executors, decided on [What is the contract between entail and any executor?](https://github.com/omkarbhale/entail/issues/30).
- Decided on [What form do intake criteria take, and when does writing them need the owner?](https://github.com/omkarbhale/entail/issues/21), after its first resolution.
