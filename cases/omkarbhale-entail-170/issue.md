# entail treats decision records and the spec like the vision, and resists improvements

entail treats decision records (`docs/adr/`) and the MVP-1 spec as if they bind like the vision. Because of that, it resists product improvements that only change a past design decision.

### What happened

On #169 ("Entail user interface on board should be good"), entail's first criteria locked in "the board stays server-rendered HTML with no front-end framework and no UI build step, as ADR 0017 and the MVP-1 spec describe". When the issue was edited to ask for a front-end framework, entail's re-check raised the change to the board as a consequential call, instead of clearing it.

The owner's note on that board answer:

> Entail made reasoning here based on ADRs and MVP-1 criteria, but failed to accept issues that improve a product even though the request was an improvement to the product in my opinion

### Expected

- Only `VISION.md` and the repo's pins decide whether a ticket goes ahead or comes to the owner.
- Decision records and the spec are design history. They can inform how a change is built, but they shouldn't block a ticket or narrow it.
- When a ticket overturns a past decision, its criteria should include updating or superseding that decision record, rather than resisting the change.
