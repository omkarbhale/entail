# entail

entail lets an owner own the vision of a product while implementation and decisions happen automatically: it judges each ticket against the vision of record and brings only the calls the vision cannot settle to the owner.

## Language

### Tickets and the forge

**Ticket**:
entail's own record about one issue it has taken into intake, holding its verdicts, criteria, board items, PRs, calls and state. An issue entail never took in has no ticket, and an issue has at most one.
_Avoid_: Task, item, story

**Issue**:
The GitHub or GitLab issue a ticket is about; it stays the reporter's words on the forge. Its text is a request to be judged, never the owner's word, whoever filed it.
_Avoid_: Ticket (for the forge object)

**PR**:
A GitHub pull request or a GitLab merge request. entail may say "merge request" in a comment it posts on GitLab.
_Avoid_: MR, merge request, pull request, change

**Executor**:
Whatever picks up a cleared issue and does its work, such as firstmate, a Claude Code action or a person; entail never executes.

### Judging a ticket

**Vision of record**:
The repo's statement of what the product is and what the owner has said should be in it, each line with a recorded origin: VISION.md on the default branch, and nothing proposed elsewhere until it lands there.
_Avoid_: Spec, roadmap

**Vision line**:
One line of the vision of record, normally one sentence, identified by its exact text; changing its words makes a new line.
_Avoid_: Clause, rule

**Origin**:
How a vision line came to be in the vision: stated by the owner, proposed by an agent and approved by the owner, or added automatically with the owner notified. Whoever writes a line records its origin when they write it, and a line that arrives with no record is stated by the owner. It is kept in entail's records, never in the vision's prose.
_Avoid_: Provenance, author

**Vision change**:
A new version of the vision of record, seen as the vision lines it removed and the ones it added.

**Decider**:
The part of entail that gives a ticket its verdict, judged against the vision of record and the repo's pins.

**Reading**:
One defensible interpretation of a ticket, with the outcome a user would observe if it were done that way.

**Verdict**:
The decider's answer to whether one ticket needs the owner: **settled**, **small** or **needs the owner**. A ticket keeps every verdict it has been given, each with its reason.

**Settled**:
The verdict that the vision of record settles the ticket: its cited passages choose one reading. It carries a citation.

**Small**:
The verdict that a ticket the vision does not settle is small and reasonable, so it goes ahead anyway: a fix, chore, refactor, test, docs or performance change that adds nothing users can see or do, touches no high-stakes area or pin, and has one reading. It carries why it is both.

**Needs the owner**:
The verdict that the ticket goes to the board: the vision cannot settle it and it is not small, it contradicts a vision passage, or it touches a pin.

**Citation**:
The vision passage that a settled verdict, or any call that says the vision settles something, relies on: one or more whole vision lines, quoted word for word, at the vision's commit.

**Pin**:
A topic the owner has said must always come to them, even where the vision settles it or no decision exists yet, optionally with paths and keywords that also mark it as touched. The vision itself is always pinned, in every repo.

**Challenge**:
An independent second judgment that tries to overturn an automatic verdict by finding another reading, an uncited assumption, a touched pin or a high-stakes area; if it succeeds, the ticket needs the owner.

**Criteria**:
What one ticket's PR must contain, written by entail because an issue carries no implementation idea: a few numbered outcomes, namely what is true once the issue is resolved and any vision constraint the change must respect. When the cause of a reported problem is unknown, they also include that the PR identifies and explains it. Each outcome is traced to its source (the issue, a vision line, a small category or the owner's answer) and may carry mechanical checks. They are published on the issue when the ticket is cleared and are frozen from then on; only a new version written by a new call changes them.
_Avoid_: Acceptance criteria, requirements

**Mechanical check**:
A part of a criterion that entail computes from what the forge reports alone, with no model: the PR changes a path, leaves a path alone, or a named check passes.

**Generic criteria**:
The checks every PR in a repo must pass, fixed once per repo.

### Ticket states

**Deciding**:
The ticket has been taken in, and is not yet cleared, declined or on the board: entail is giving it a verdict or writing its criteria.

**Declined**:
Final: the ticket is too large for one PR, so entail will not take it forward. Size is checked before any verdict, so a declined ticket has none.
Declining is a deliberate, owner-approved shortfall in MVP-1: VISION.md says entail breaks a ticket too large for one PR into smaller tickets, and splitting is the next effort.

**On the board**:
The ticket has an open board item and waits for an answer.

**Cleared**:
The ticket needs no product decision from the owner, or the owner has answered it, and its criteria are published on the issue for any executor.
_Avoid_: Started, approved, ready

**Landing**:
A PR linking the issue is open and is being checked against the criteria and generic criteria; a failed landing check leaves the ticket landing.

**Merged**:
Final: the ticket's PR has merged, whether entail merged it or someone else did.

**Cancelled**:
Final: the owner's answer said not to go ahead; someone other than entail closed the issue before its PR merged; or entail closed it at intake because the vision or the repo's state settles that nothing is to be done, such as a duplicate or an already-fixed report.

### Decisions and records

**Board item**:
One product decision raised to the owner about one ticket, carrying what the ticket was, what happened and why it was raised. A ticket has at most one open board item at a time.
_Avoid_: Question, card, escalation

**Call**:
One decision entail made itself about a ticket, recorded with its reason and, where the vision settled it, its citation. A board answer is not a call; the change it causes is a call that cites the answer.
_Avoid_: Event, action

**Audit log**:
The append-only record of every call, readable by the owner.
