# A vision line's origin is recorded by its writer, and an unrecorded line is the owner's

An agent that edits VISION.md records each new or reworded line's origin when it writes the line, as a `Vision-Origin:` trailer on the commit. A change that arrives with no trailer is the owner's own hand edit and is recorded as stated by the owner. entail asks nothing afterwards. The owner's reasoning is that the agent making a change always knows its origin, so asking afterwards only recovers what the writer could have recorded. Forge authorship cannot tell the owner from an agent (ADR-0001). Trusting the trailer is safe enough because VISION.md is a built-in pin: an agent's PR that touches it never merges automatically, so the owner sees it first.

## Considered options

- **entail pre-fills origins and the owner confirms each vision change on the board page**: rejected by the owner. It adds a step to every vision edit that the writer could have made unnecessary.
- **New lines cannot be cited until the owner confirms them**: rejected. It stalls deciding on every vision edit.
- **Inferring the origin from who pushed the commit**: impossible. Agents push under the owner's login.

## Consequences

- The trailer's value names one origin: `owner-stated`, `agent-proposed-owner-approved` or `automatic-owner-notified`. It applies to every line the commit adds, so lines with different origins go in separate commits.
- A /vision run records `agent-proposed-owner-approved`, because /vision drafts and the owner approves. /vision itself writes no trailer, so the agent that commits its output adds one.
- A missing trailer, or one whose value is not on that list, records the line as stated by the owner. The raw trailer, if there is one, is kept on the origin entry.
- For each line a vision change adds, entail reads the trailer of the commit that added the line, in its local read-only checkout.
- At enrollment, the existing VISION.md is recorded under one origin that the owner picks once in the repo's enrollment settings.
- The protection holds only for agents that reach VISION.md through a PR. An agent that commits to the default branch directly without the trailer would have its lines recorded as the owner's. The rule that agents add the trailer belongs in the instructions agents read for that repo, such as its `AGENTS.md` or `CLAUDE.md`.
- Decided on [How does a new or reworded vision line get its origin?](https://github.com/omkarbhale/entail/issues/36), from the owner's answer: "If an agent is the one who always makes changes to vision.md, then it would always know the origin."
