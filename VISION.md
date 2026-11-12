# Vision

`entail` exists so that an owner can own the vision of a product while implementation and decisions happen automatically.
It serves an owner who runs agent-driven work on their own repositories, and it turns a ticket plus a durable vision into started work, a closed ticket with its reason, or one question.
It owns one thing: the product call on each ticket and each PR, made as the owner would make it, and the call on when to ask the owner instead.

## The vision is the record

The vision of record states what the product is and what the owner has said should be in it.
Every line has a recorded origin: stated by the owner, proposed by an agent and approved by the owner, or added automatically with the owner notified.
That origin is kept outside the vision's prose; VISION.md itself carries no per-line marks.
No one else's words come to read as the owner's, whether an agent's proposal or a collaborator's answer, because that is drift nobody chose.
The vision grows by hand, or automatically with the owner notified, and never silently.
A board answer enters the vision only when it truly makes sense as a general statement; most answers settle their own ticket and stop there.
The vision stays proportionate to the real complexity of the project, so months of daily answers do not make it grow much, and it is never padded first and cut back later.
A vision is first written with the /vision skill; entail checks work against it and grows it as above.

## Better, or the owner decides

entail accepts a ticket when doing it would make the product better, closes it with the reason when it would not, and asks the owner when it cannot tell or when the change is large or hard to undo.
The vision is the owner's word on what better means for this product: where it speaks it decides, and where it is silent entail judges the change on its merits.
A ticket that plainly goes against a vision line is closed quoting that line; the owner reopens it to change the vision.
Where a request can be read more than one way, entail picks the reading that best serves the product and states it, and asks only when the readings would give users noticeably different results.
Sufficiency is judged for the ticket at hand, not for the whole vision.
A small, easily undone call does not need certainty; a large or hard-to-undo one does.
Every "the vision settles this" cites the passage relied on, and a vision change flags in-flight work that relied on the old text.
The owner can pin a topic in advance so that anything touching it comes to them, even where no decision exists yet.
Tolerance scales with stakes: a minor wrong call is acceptable and fixable later, while a large rework or significant drift from the vision never happens unasked.

## Automatic by default, auditable after

entail rests on the bet that models are intelligent enough already, and that what is missing is the engineering to use them.
A ticket entail accepts starts work from an issue or mention without asking the owner, on a zero-ceremony path.
A ticket too large for one PR is broken by entail into smaller tickets, each judged on its own: the ones it clears start and the rest go to the board.
A PR merges when it solves its ticket's problem, meets its criteria and leaves the product better; finishing accepted work does not wait on the owner any more than starting it does.
Every call settled automatically is logged with its reason, so it can be audited later.
Choices a model does not notice it is making cannot be caught reliably, so entail makes them visible and attributable afterwards instead of claiming to prevent them.
entail also checks merged work against the current vision on a schedule and files a ticket for any drift it finds, which then goes through the same intake as any other.
entail's judging is measured against a case book of real tickets and the owner's own calls on them.
A change to how entail judges is checked by replaying that book before it lands, so a fix for one case does not quietly break another.
Autonomy grows as the vision covers more and trust is earned.
Board answers earn it too, the owner's or an allowed collaborator's: once the same kind of question has been answered the same way repeatedly, entail settles that kind of question itself and cites those answers instead of a vision passage.

## The board holds only product decisions

Product decisions reach the owner on a board, not in chat.
The board holds only product decisions; whether to start, pause or reorder work is not a board item.
Its value over chat is structure: each item carries what the ticket or task was, what happened, and why it was raised.
When an item is raised, entail may send a short notice with a link to wherever the owner already is, carrying no question text and taking no answer.
The owner can let a collaborator answer board items for a repo, and those answers settle tickets the same way the owner's do.
Every answer is recorded under the name of whoever gave it, through a single path that records answers.

## Criteria at intake and at landing

At intake, a ticket gets its call, and one that is accepted is answered with the few criteria an implementer would not guess.
At landing, the PR is checked for everything the ticket required, plus the repo's generic criteria, such as whether the tests ran.
When a PR fails its criteria, entail decides whether to comment on the PR with what needs to change, raise it again, or cancel it, and it never fixes the PR itself.
Cancelling a ticket whose PR keeps failing is entail's call, logged with its reason, and does not need the owner.
Generic per-repo criteria are a setting fixed once per repo, not a question asked per ticket.
Facts a machine can read, such as whether CI passed or which files a PR changes, are read from the forge and never taken from the PR's own claims; whether a change is good is judged by a model that did not write it.
Every verdict persists with its reason.

## How it runs

entail works with or without firstmate; without it quality may drop and firstmate's own features are missing, but everything entail does stays possible.
Personal use and local-first operation are acceptable.

A change aligns when it brings entail's call on a ticket or a PR closer to the one the owner would make: accepting what makes the product better, closing what does not with its reason, merging a PR that solves its ticket's problem and leaves the product better, and asking the owner only when entail cannot tell or the change is large or hard to undo, with what the ticket was, what happened, and why it was raised.
A change should be resisted when it lets entail accept a ticket that would not make the product better or that plainly goes against a vision line, close a ticket without its reason, merge a PR that does not solve its ticket's problem, or ask the owner about a small, easily undone call it could make itself; when it changes how entail judges without replaying the case book; or when it records anyone's words as the owner's, grows the vision with rulings that are not general statements, settles a call without citing the vision passage or past answers it relies on, or without logging the reason, moves a question or its answer into chat, makes entail depend on firstmate, or puts work-management traffic on the board.
