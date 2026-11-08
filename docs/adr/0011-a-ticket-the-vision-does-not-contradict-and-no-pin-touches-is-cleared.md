# A ticket the vision does not contradict and no pin touches is cleared

A ticket that contradicts no vision line, touches no pin and has no consequential readings is cleared, even where the vision is silent. Its verdict is **unopposed**. entail keeps no list of change categories and no high-stakes areas of its own. What matters for a project, such as an interface people depend on, new features being opt-in, or how it looks, is said in that project's VISION.md and pins. This replaces the **small** verdict and its bar from ADR-0002.

The owner decided this while clicking through the board prototype. A `tally` item asking what `--json` should print had reached the board, and the owner said it "should never come to me, additive or not". They continued: "It should if its API people depend on, but then in that case that project's vision would say about API changes, not entail. For example, firstmate's vision says that new features should always be opt-in." And then: "Actually, just make them all go ahead on their own. If it makes sense with the vision, it'll be marked as clear from entail. That's all, then executor has still to decide whether to pick it."

Readings decide the rest:
- Readings are **consequential** when their outcomes differ, a vision line or pin bears on that difference, and nothing in the vision chooses between them. A ticket with consequential readings needs the owner.
- Readings that differ only in detail the vision does not speak to, such as the shape of a JSON output, never reach the owner. entail picks the more conventional reading, states it in the criteria, and logs the choice with the verdict.
- A reading that would contradict a vision line is not a defensible reading. The ticket contradicts the vision only when every reading does.

## Order of judgment

This replaces step 4 of the order decided on [How does the decider reach a verdict on a ticket?](https://github.com/omkarbhale/entail/issues/19):

1. **Size.** An oversized ticket is declined.
2. **Pins.** A touched pin needs the owner. VISION.md is a pin in every repo.
3. **Contradiction.** A ticket every reading of which contradicts a vision line needs the owner, with the line cited.
4. **Readings.**
   - If cited vision lines choose one reading, the verdict is **settled**.
   - If the readings are consequential, the ticket needs the owner.
   - Otherwise the verdict is **unopposed**, with the reading chosen.

## Considered options

- **Keep small: a closed list of categories with high-stakes exclusions** (ADR-0002): rejected by the owner. It sent minor, uncontradicted tickets such as `--json` to the board, and it built one idea of what is risky into entail for every project, when that belongs in each project's vision.
- **Keep small and only drop "adds nothing users can see or do"**: rejected. The exclusions would still decide for every project what matters.
- **Ask whenever readings diverge**: rejected by the owner for minor detail. Only readings the vision makes consequential reach the board.

## Consequences

- **Verdict shape.** `category`, `why_small` and `why_reasonable` give way to `why_unopposed` and `reading_chosen`. `why_raised` loses "vision silent" and gains "consequential readings".
- **No contradiction found.** An unopposed verdict relies on no vision passage, so it has nothing to cite. Its call records "no contradiction found" in place of a citation, beside the vision check's bearing lines, `why_unopposed` and the reading chosen. The intake comment says the same. VISION.md asks every "the vision settles this" to cite its passage; an unopposed clear does not claim the vision settles it.
- **Mechanical checks** (ADR-0002) stay, minus the category check. An unopposed verdict must list the vision check's bearing lines with no line marked as contradicted, and must name no touched pin.
- **The challenge** (ADR-0002) now looks for a vision line the ticket contradicts, a touched pin, a consequential reading the decider missed, or an uncited assumption behind a settled citation. It no longer looks for a high-stakes area. It runs on settled and unopposed verdicts.
- **Criteria** (ADR-0005) no longer cite a small category. Where entail chose between readings, a criterion states the reading it chose. An unopposed ticket carries leaves-path fences for every pin's paths and for VISION.md, as a small ticket did.
- **More is cleared.** A cleared issue is still only an offer. Whether any executor picks it up is the executor's call, outside entail.
- **Wrong clears are fixed downstream.** A project that wants a kind of change to come to the owner says so in its vision or adds a pin. VISION.md accepts minor wrong calls as fixable later, and the Calls page shows every one.
- **entail's own vision changed.** The "small, reasonable ticket" exception, the pink-headings line and the matching closing tests were amended in the same PR, as stated by the owner.
- **The acceptance test changed.** The `tally` fixture's expected outcomes are amended in ADR-0010.
- Decided on [How should the board page look and behave when the owner answers an item?](https://github.com/omkarbhale/entail/issues/29), amending [How does the decider reach a verdict on a ticket?](https://github.com/omkarbhale/entail/issues/19).
