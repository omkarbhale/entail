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
Whatever picks up a cleared issue and does its work, or picks up an issue marked for investigation and reports its findings, such as firstmate, a Claude Code action or a person. By default anyone can be one, and entail checks any PR that links a cleared issue, whoever opened it; a repo can instead count only the owner and the executors listed for it. entail never executes.

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
One defensible interpretation of a ticket, with the outcome a user would observe if it were done that way. A ticket's readings are **consequential** when their outcomes differ, a vision line or pin bears on that difference, and nothing in the vision chooses between them. Readings that differ only in detail the vision does not speak to are not consequential: entail picks the more conventional one and states it in the criteria.

**Verdict**:
The decider's answer to whether one ticket needs the owner: **settled**, **unopposed** or **needs the owner**. A ticket keeps every verdict it has been given, each with its reason.

**Settled**:
The verdict that the vision of record settles the ticket: its cited passages choose one reading. It carries a citation.

**Unopposed**:
The verdict that no vision line settles the ticket, but none contradicts it, it touches no pin and its readings are not consequential, so it is cleared. entail keeps no list of change categories or high-stakes areas of its own: what matters for a project is said in its vision and pins. With nothing to cite, it records "no contradiction found" in place of a citation, with why nothing opposes the ticket and, where readings differed, the one entail chose.
_Avoid_: Small

**Needs the owner**:
The verdict that the ticket goes to the board: it contradicts a vision line, touches a pin, or has consequential readings, or an automatic verdict failed its checks or challenge.

**Citation**:
The vision passage that a settled verdict, or any call that says the vision settles something, relies on: one or more whole vision lines, quoted word for word, at the vision's commit.

**Pin**:
A topic the owner has said must always come to them, even where the vision settles it or no decision exists yet, optionally with paths and keywords that also mark it as touched. The vision itself is always pinned, in every repo.

**Challenge**:
An independent second judgment that tries to overturn an automatic verdict by finding a vision line the ticket contradicts, a touched pin, a consequential reading or an uncited assumption; if it succeeds, the ticket needs the owner.

**Criteria**:
What one ticket's PR must contain, written by entail because an issue carries no implementation idea: a few numbered outcomes, namely what is true once the issue is resolved and any vision constraint the change must respect. Each outcome is traced to its source (the issue, a vision line or the owner's answer) and may carry mechanical checks. They are published on the issue when the ticket is cleared and are frozen from then on; only a new version written by a new call changes them.
_Avoid_: Acceptance criteria, requirements

**Evidence**:
An executor's report in a PR of what it ran or did for each criterion, and the result, entered under the criterion's id. It is taken as honest, and a criterion with no evidence is not met.
_Avoid_: Validation report, proof

**Findings**:
An executor's report on an issue under investigation, answering each question the investigation had to establish by its id. Like all issue text, they are judged, never taken as the owner's word.
_Avoid_: Investigation report, triage notes

**Mechanical check**:
A part of a criterion that entail computes from what the forge reports alone, with no model: the PR changes a path, leaves a path alone, or a named check passes.

**Generic criteria**:
The criteria every PR in a repo must meet, with ids G1…Gn. entail proposes them from the repo when it is enrolled, and the owner confirms them once. They are frozen with each ticket when it is cleared, so a later change applies only to tickets cleared after it.

**Landing check**:
entail's check of one PR at one head before it merges. Mechanical checks run first. A grader then judges every criterion and generic criterion against the evidence and the diff, and a challenge tries to overturn it. A PR that changes something users can observe beyond its criteria does not pass.
_Avoid_: Review, validation, gate

**Landing comment**:
The attributed comment entail posts on a PR after each landing check. It marks each criterion and generic criterion as met or not met, names the head checked, and says whether entail is merging.

**Shadow**:
A per-repo setting, off by default, under which entail decides tickets and runs landing checks but leaves every merge to the owner.
_Avoid_: Dry run, manual mode

**Intake comment**:
The attributed comment entail posts on an issue each time it decides the ticket, in two sections: a vision check, then what happens next. That is the criteria and the label `entail:cleared`, what an investigation must establish and the label `entail:investigate`, or that the ticket was raised to the owner.
_Avoid_: Triage comment, criteria comment

**Vision check**:
The first section of an intake comment: each vision line that bears on the issue, quoted whole, marked as matched, contradicted or not settling it. Lines that do not bear on the issue are left out, and the check says so.

### Ticket states

**Deciding**:
The ticket has been taken in, or its investigation findings have arrived, and it is not yet cleared, investigating, declined or on the board: entail is giving it a verdict or writing its criteria.

**Investigating**:
Whether the issue describes a real problem, or what causes it, is unknown, so entail has marked it for investigation and waits for an executor's findings on the issue. Investigating is not a verdict and needs no PR. A ticket is investigated at most once.
_Avoid_: Triage, needs info

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
Final: the owner's answer said not to go ahead; someone other than entail closed the issue before its PR merged; or entail closed it because the repo's state or an investigation's findings settle that nothing is to be done, such as a duplicate, an already-fixed report or a problem that cannot be reproduced.

### Decisions and records

**Board item**:
One product decision raised to the owner about one ticket, carrying what the ticket was, what happened and why it was raised. A ticket has at most one open board item at a time.
_Avoid_: Question, card, escalation

**Withdrawn**:
What becomes of an open board item whose basis changed before it was answered: someone else closed the issue, or a vision change or pin change touched the item. A withdrawn item takes no answer; its ticket is cancelled or decided again.

**Answer**:
The owner's response to one board item, recorded under the name of whoever gave it. It settles that ticket only and is final once given. An answer that does not let the ticket go ahead is "don't go ahead", and the ticket is cancelled.
_Avoid_: Ruling, decline, approval

**Option**:
One way to go ahead that a board item offers the owner, usually one of the ticket's readings with the outcome a user would observe. The owner may instead answer in their own words.
_Avoid_: Choice, alternative

**Call**:
One decision entail made itself about a ticket, recorded with its reason and, where the vision settled it, its citation. An unopposed clear, where the vision is silent, records "no contradiction found" instead. A board answer is not a call; the change it causes is a call that cites the answer.
_Avoid_: Event, action

**Audit log**:
The append-only record of every call, readable by the owner on a page of its own, apart from the board. Reading it changes nothing; a wrong call is fixed through the issue, the vision or a pin.

**Records**:
Everything entail keeps about the repos it serves: tickets, calls, answers, origins and vision changes. They are append-only, so a ticket's state changes only through a new call, and they are kept by entail, never in a project's repo or on its issues.
_Avoid_: Database, history

**Records repo**:
The git repository where entail keeps a copy of its records so they outlive the machine it runs on, pushed to a remote the owner chooses and never to one known to be public.
_Avoid_: Backup
