# Board answers come only through the board form and settle only the call they were asked

> **Amended by ADR-0020.** An issue edit, or a deleted or moved issue, also withdraws an open item. A finished ticket's issue comes back only when the owner pulls it in again with `/entail`, as a new ticket; reopening it does nothing.

The owner answers a board item only through the answer form on entail's local board page. entail never takes an answer from an issue comment, a chat or a command line. VISION.md asks for "a single path that records answers". Agents post on the forge under the owner's own login (ADR-0001), so a reply on the issue could not be told apart from an agent's words. A reply there would also move the question and its answer back into a thread. The page is served on localhost, so whoever answers there is recorded under the owner's name from entail's settings, with the time and the item version answered.

An answer has one of three shapes, and any of them may carry a note:
- **choose an option**, one of the open readings, or "go ahead as read" when there is one;
- **answer in your own words**;
- **don't go ahead**.

An answer settles the product call that was raised, and nothing more. A going-ahead answer returns the ticket to deciding only to write criteria. The verdict is not run again. The answer is a source the criteria cite, and the usual criteria checks and challenge still run. A product call the answer does not cover raises a new board item for that call alone. "Don't go ahead" cancels the ticket, and entail closes the issue as not planned.

## Considered options

- **Also accept an answer as an issue comment** (for example `/entail answer ...`): rejected by the owner. It cannot be attributed, and it is a second path.
- **Also accept an answer from a command line**: rejected by the owner, as a second path.
- **Run the decider again with the answer as input**: rejected. The verdict already said what needed the owner, and running it again could reopen calls the owner just made, or settle new ones without them.
- **Offer "later", "pause", "reorder" or "split"**: not offered. The first three are work management, which VISION.md keeps off the board, and splitting is the effort after MVP-1.

## Consequences

- Answers are final. To stop a ticket after going ahead, the owner closes the issue, which cancels the ticket. Reopening a cancelled issue belongs to the open question of issues edited after intake.
- The intake comment posted after an answer (ADR-0007) quotes the decision, attributed to the owner: the chosen option, or the owner's own words when they answered that way, since the executor needs it. A note appears on the issue only if the owner ticks "show my note on the issue" on the form. The rest stays in entail's local records, since repos may be public.
- An item raised for a pin, once answered, counts as the owner having seen that pin for the ticket, and the same pin does not raise it again.
- An open item whose basis changes is withdrawn, and the form refuses answers to it:
  - an outside close cancels the ticket;
  - a vision change touching the item's vision check, or adding a line, makes the ticket be decided again;
  - so does a pin change that touches it.
- The change each answer causes is a call that cites the answer, and the answer itself is not a call.
- Decided on [What does a board item contain, and how does an answer settle its ticket?](https://github.com/omkarbhale/entail/issues/23).
