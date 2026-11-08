# Vision

`entail` exists so that an owner can own the vision of a product while implementation and decisions happen automatically.
It serves an owner who runs agent-driven work on their own repositories, and it turns a ticket plus a durable vision into either started work or one structured question.
It owns exactly one thing: the call on which decisions need the owner, judged against a vision of record.

## The vision is the record

The vision of record states what the product is and what the owner has said should be in it.
Every line has a recorded origin: stated by the owner, proposed by an agent and approved by the owner, or added automatically with the owner notified.
That origin is kept outside the vision's prose; VISION.md itself carries no per-line marks.
No one else's words come to read as the owner's, whether an agent's proposal or a collaborator's answer, because that is drift nobody chose.
The vision grows by hand, or automatically with the owner notified, and never silently.
A board answer enters the vision only when it truly makes sense as a general statement; most answers settle their own ticket and stop there.
The vision stays proportionate to the real complexity of the project, so months of daily answers do not make it grow much, and it is never padded first and cut back later.
A vision is first written with the /vision skill; entail checks work against it and grows it as above.

## What the vision cannot settle goes to the owner

Whatever the vision cannot settle comes back to the owner, including new things that contradict nothing but that nothing asked for, with exactly two exceptions: small, reasonable tickets and rulings learned from repeated board answers.
A small, reasonable ticket starts automatically even where the vision is silent, because removing that friction is what entail is for.
Small is not enough on its own; a small change the owner probably does not want, such as turning the headings pink, does not start by itself.
The vision does not settle a call when two or more defensible readings lead to observably different outcomes and nothing in it chooses between them.
Sufficiency is judged for the ticket at hand, not for the whole vision.
When unsure, entail asks, because a wrong "already settled" silently applies a ruling to a case it never covered, while an extra question is cheap.
Every "the vision settles this" cites the passage relied on, and a vision change flags in-flight work that relied on the old text.
The owner can pin a topic in advance so that anything touching it comes to them, even where no decision exists yet.
Tolerance scales with stakes: a minor wrong call is acceptable and fixable later, while a large rework or significant drift from the vision never happens unasked.

## Automatic by default, auditable after

entail rests on the bet that models are intelligent enough already, and that what is missing is the engineering to use them.
A ticket the vision plainly settles starts work from an issue or mention without asking the owner, on a zero-ceremony path.
A ticket too large for one PR is broken by entail into smaller tickets, each judged on its own: the settled ones start and the rest go to the board.
A PR that passes its criteria merges automatically; finishing settled work does not wait on the owner any more than starting it does.
Every call settled automatically is logged with its reason, so it can be audited later.
Choices a model does not notice it is making cannot be caught reliably, so entail makes them visible and attributable afterwards instead of claiming to prevent them.
entail also checks merged work against the current vision on a schedule and files a ticket for any drift it finds, which then goes through the same intake as any other.
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

At intake, a ticket is checked against the vision and answered with what its PR must contain.
At landing, the PR is checked for everything the ticket required, plus the repo's generic criteria, such as whether the tests ran.
When a PR fails its criteria, entail decides whether to fix it itself, raise it again, or cancel it.
Cancelling a ticket whose PR keeps failing is entail's call, logged with its reason, and does not need the owner.
Generic per-repo criteria are a setting fixed once per repo, not a question asked per ticket.
A check the model grades on itself can be bypassed, so entail prefers mechanical checks wherever a criterion allows one.
Every verdict persists with its reason.

## How it runs

entail works with or without firstmate; without it quality may drop and firstmate's own features are missing, but everything entail does stays possible.
Personal use and local-first operation are acceptable.

A change aligns when it lets a ticket the vision settles move from intake through a criteria-checked merge without the owner, or when it brings a call the vision cannot settle to the owner with what the ticket was, what happened, and why it was raised.
A change should be resisted when it lets entail act on a call the vision does not settle outside its two named exceptions, records anyone's words as the owner's, grows the vision with rulings that are not general statements, settles a call without citing the vision passage or past answers it relies on, or without logging the reason, moves a question or its answer into chat, makes entail depend on firstmate, or puts work-management traffic on the board.
