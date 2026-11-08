# Automatic verdicts pass checks and a challenge, not the model's confidence

> **Amended by ADR-0011.** The **small** verdict, with its categories and high-stakes exclusions, is replaced by **unopposed**: a ticket the vision does not contradict, that touches no pin and has no consequential readings is cleared. The checks and the challenge below still apply to settled and unopposed verdicts, without the category check or the high-stakes area.

A settled or small verdict clears a ticket only after entail itself checks it mechanically and an independent challenge fails to overturn it; any failure makes the ticket need the owner. VISION.md says a wrong "already settled" is costly while an extra question is cheap, and that a check a model grades on itself can be bypassed, so the model must argue its way to an automatic verdict instead of rating its own certainty.

## Considered options

- **A confidence score or "when unsure, say so" in the prompt**: rejected as self-assessment.
- **"Would the owner probably want this?" as the small test**: rejected for the same reason. Small is instead a closed list of categories (fix, chore, refactor, test, docs, performance) that add nothing users can see or do, with high-stakes exclusions (a public interface or data format, persisted data or migrations, auth, security, permissions or secrets, licensing, a new dependency). Small applies only where the vision does not settle the ticket.

## Consequences

- The verdict lists the ticket's readings, so "two or more defensible readings and nothing chooses between them" is a field entail tests, not a sentence in a prompt.
- Mechanical checks: every citation appears word for word in the current VISION.md; settled has a citation; with several readings, a cited passage chooses one; small names an allowed category and no exclusion; no pin is touched by the model's judgment or by a keyword or path match.
- The challenge runs only on settled and small verdicts, costing one more model run per automatically cleared ticket.
- A machine failure (no output, error, timeout, refusal, usage limit) is not a product decision: the ticket stays deciding and is retried, never put on the board. A citation that fails the word-for-word check is a product failure and needs the owner.
- Decided on [How does the decider reach a verdict on a ticket?](https://github.com/omkarbhale/entail/issues/19).
