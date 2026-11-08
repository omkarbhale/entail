# The intake comment opens with a vision check, then says what happens next

When entail decides a ticket, it posts one intake comment on the issue in two sections, under the attribution line ("Speaking from Omkar's entail:"). The owner chose this shape, modelled on how firstmate triages an issue: "First: it goes over the issue raised one by one over each vision statement to check if it matches. Then if it does: it lists the criteria it wants in the raised PR, then gives it the label that this issue can accept PR."

1. **Vision check.** Each vision line that bears on the issue is quoted whole and word for word, with a permalink at the vision's commit, and marked as one of:
   - the issue **matches** it;
   - the issue **contradicts** it;
   - the line **does not settle** the issue.

   Only lines that bear on the issue are listed, not all of VISION.md, and the comment says so. If no line bears on it, the check says that.
2. **What happens next.**
   - If the ticket goes ahead, this section lists the criteria the PR must meet (C1…Cn, their mechanical checks, and a note that the repo's generic criteria also apply), then names the label: `entail:cleared`.
   - If the ticket is investigated instead, this section states what the investigation must establish and names the label `entail:investigate`.
   - If the ticket goes to the board, this section says it was raised to the owner and links the board. It carries no question text and takes no answer.

The vision check makes every judgment readable on the issue itself, including the lines the decider found silent, so the reporter, the executor and the owner see the same reasoning. VISION.md requires that every "the vision settles this" cites its passage, and this shape also shows what the vision did not settle.

## Considered options

- **Quote only the cited passage** (the settled verdict's citation): rejected, because it hides the lines the decider judged silent or contradicted, which is where a wrong call would show.
- **Walk every line of VISION.md**: rejected by the owner ("only lines that bear on it"). It would bury the few lines that matter.
- **Criteria comment and board notice as separate comments**: rejected. One comment per decision keeps the reasoning and its outcome together; the board path's comment is the notice that an item was raised.

## Consequences

- The decider's output gains a vision check field: the bearing lines, each with its mark. Every settled citation must be marked **matches**, and any line marked **contradicts** makes the ticket need the owner, as decided on [How does the decider reach a verdict on a ticket?](https://github.com/omkarbhale/entail/issues/19).
- entail checks the vision check mechanically like any citation: every quoted line appears word for word in VISION.md at the recorded sha.
- Each new decision on a ticket (after investigation findings, a board answer or a new criteria version) posts a new intake comment in the same shape, naming the one it replaces. entail's record stays the authority, and the comment is a copy (ADR-0005).
- A declined ticket gets no vision check, because size is checked before any verdict. Its comment gives the reason. A close at intake rests on the repo's state, and its comment gives its evidence.
- Quoted vision lines sit in a quote block, so no line of the comment starts with `/`.
- The shape is part of the contract with executors, decided on [What is the contract between entail and any executor?](https://github.com/omkarbhale/entail/issues/30) (ADR-0013). Section 2 ends with one fixed line telling any executor how to report evidence or findings.
