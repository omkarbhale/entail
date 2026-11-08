# Criteria are a few outcomes with mechanical checks, and the owner never signs them off

entail writes each cleared ticket's criteria itself, because an issue is a request or a symptom with no implementation idea. The criteria are a few numbered outcomes: what is true once the issue is resolved, plus any vision constraint the change must respect, which may restate a vision line. Each criterion is one sentence traced to its source. Where it can, it carries **mechanical checks** from a closed list that entail computes from forge data alone: the PR changes a path, leaves a path alone, or a named check run, status or pipeline job passes. The owner never signs criteria off. A criterion that would fix something a user can observe, which its source does not choose, is a product call and sends the ticket to the board. VISION.md prefers mechanical checks wherever a criterion allows one and gives settled work a zero-ceremony path. entail never runs code, so the forge's diff and check results are all it can verify mechanically.

## Considered options

- **Statements only, all graded by a model**: rejected, because it ignores VISION.md's preference for mechanical checks.
- **Mechanical criteria only**: impossible. Most outcomes cannot be checked from forge data without running the code.
- **Mechanical and graded criteria as separate items**: rejected. One outcome such as "a test covers X and passes" would split into loosely linked pieces.
- **Text-matching checks** (the diff must add a given string): left out, because they are brittle and invite gaming the wording.
- **The owner signs off all criteria**, or only on tickets they answered: rejected by the owner. It puts a step in front of settled work, or a second round trip after each board answer.
- **The decider writes criteria in the same run as the verdict**: rejected. It wastes criteria on tickets that go to the board and mixes two questions in one prompt.

## Consequences

- **Writing.** A separate read-only `claude -p --json-schema` run writes the criteria, after a settled or small verdict passes its mechanical checks, or after a board answer lets the ticket go ahead.
- **Checks before clearing.** entail checks the output mechanically:
  - between one and five criteria;
  - each has a source that exists;
  - each mechanical check is a known kind with valid arguments;
  - a small ticket carries leaves-path fences for every pin's paths and the vision's;
  - no line starts with `/`.

  The existing challenge then runs once over the verdict and the criteria together. Invalid output is a machine failure and is retried. A product call, or a challenge that succeeds, sends the ticket to the board.
- **Freezing.** entail's record is the authority. The issue comment is a copy, and editing it changes nothing. Executors and PR text cannot change criteria, and a change is a new version written by a new call.
- **Landing.** The landing check runs mechanical checks first, and no grade overrules a failed one. A fresh session grades the rest. Every "met" quotes its evidence word for word from the PR at the checked head, and no evidence means not met.
- **Unknown causes.** Criteria are written only once the problem is known. When the cause or validity of a report is unknown, the ticket is investigated first (ADR-0006).
- Decided on [What form do intake criteria take, and when does writing them need the owner?](https://github.com/omkarbhale/entail/issues/21).
