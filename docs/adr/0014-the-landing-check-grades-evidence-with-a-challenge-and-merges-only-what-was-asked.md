# The landing check grades evidence with a challenge and merges only what was asked

> **Amended by ADR-0016.** A landing check runs once for each distinct head sha, latest evidence section and criteria version. No PR for a flagged ticket merges until its re-check is recorded, and just before merging entail reads VISION.md's blob again.

When a PR for a cleared ticket is ready, entail runs a **landing check** on it. Mechanical checks run first. Then a fresh grader judges each criterion and each generic criterion against the PR's evidence and diff, and an independent challenge tries to overturn every "met". A PR that also changes something users can observe that no criterion asked for does not merge. Each run posts one **landing comment** on the PR. A PR that passes merges through the forge API, pinned to the head sha that was checked.

VISION.md says a PR that passes its criteria merges automatically, so the merge is the step that lands work without the owner. VISION.md also says a check the model grades on itself can be bypassed, and that significant drift never happens unasked. For that reason the merge needs the same discipline as an automatic verdict (ADR-0002), and a cleared issue must not become a way to merge features nobody asked for.

## Considered options

- **One grader run**: rejected. A single model judgment would decide the one step that cannot wait for the owner.
- **Two independent graders that must agree**: rejected in favour of the challenge, which already exists for verdicts and looks for a specific failure instead of repeating the same judgment.
- **Check only the criteria, the generic criteria and the pin fences, and let anything extra merge**: rejected. An executor could add an unasked feature to any cleared issue, and the vision check at intake would then protect nothing.
- **Use the forges' own auto-merge**: rejected. entail has already waited for the checks, and a direct merge pinned to the checked sha fails if anyone pushes in between.

## Consequences

- **When it runs.** The landing check runs on a PR only when:
  - the PR is open and not a draft;
  - its base is the default branch;
  - it links a ticket with criteria in force (cleared or landing);
  - every check at its head has finished.

  It runs once for each distinct pair of head sha and latest evidence section. A new push or a new evidence section from the PR's author triggers a new run, and nothing else does. It never comments while checks are pending or on a draft. A PR into another branch is not the ticket's PR, because the forges' closing keywords act only on the default branch.
- **Order.**
  1. The forge's state: the merge guard of ADR-0013 and every criterion's mechanical checks.
  2. The grader, in a fresh read-only session. It reads the frozen criteria and generic criteria, the evidence, the diff and the check results. For each id it returns met or not met, with the evidence quoted word for word, and it lists anything users can observe that the change does beyond the criteria and their stated reading.
  3. Mechanical checks on the grade: every quoted piece of evidence appears word for word in the PR at the checked head, and every id has a result.
  4. The challenge, a second fresh run that tries to show that a criterion marked met is not met, or that the change goes beyond its criteria.

  A failed mechanical check ends the run before any model is used. PR text is untrusted input to both runs. Reading the diff lets the grader judge whether the evidence and the change fit the criterion. It does not redo the executor's validation, which entail never runs (ADR-0013).
- **Machine failures.** A grader or challenge run that errors, times out or hits a usage limit is retried. It is never reported as a failed landing (ADR-0002).
- **Where generic criteria come from** (owner). When a repo is enrolled, entail reads its CI workflows or pipeline jobs and its test and lint commands, and proposes a short list, such as "G1: the `test` check passes" and "G2: the PR reports running `npm test` and its result". The owner confirms or edits the list once, as part of enrollment. It is setup, not a product decision, so it is never a board item. How enrollment presents it is decided on [How is a repo enrolled, and what per-repo settings exist?](https://github.com/omkarbhale/entail/issues/25).
- **Generic criteria.** Generic criteria take the same form as a ticket's criteria (ADR-0005): one sentence each, with ids G1…Gn, and mechanical checks where possible, usually "a named check passes". Executors report evidence for them by id. The intake comment lists them in full under the ticket's criteria. They are frozen with the ticket when it is cleared, so a change to a repo's generic criteria applies only to tickets cleared after it. The landing call records the version it used. The ADR-0013 merge guard applies in every repo, whatever its generic criteria: every check is green and every required check has reported.
- **The landing comment.** Each run posts one attributed comment on the PR, never on the issue, whether the PR passes or fails. The comment:
  - lists each id C1…Cn and G1…Gn as met or not met, with mechanical results as computed, quoted evidence for each "met" and the reason for each "not met";
  - lists anything the change does beyond its criteria;
  - names the head sha it checked.

  A failing comment says the PR will not be merged at that head, and that a new push or a new evidence section gets it checked again. A passing comment ends "merging at `<sha>`". It follows the comment rules: the attribution line, the hidden marker and no line starting with `/`. A failed landing leaves the ticket landing. Routing a failing PR any further is a later effort.
- **A pinned path touched at landing** (owner). An unopposed ticket's criteria already fence every pin's paths and VISION.md, so a PR that touches them fails mechanically. For any other cleared ticket, a diff that touches a pinned path goes to the owner (ADR-0013), unless the owner's answer on this ticket already covered that pin.
  - entail raises the board item only after everything else in the landing check has passed, so the owner is never asked about a PR that would fail anyway.
  - The ticket goes on the board, and the PR stays open and unmerged.
  - The item names the pinned paths touched, beside the sections of ADR-0008, and takes one of three answers:
    - "Merge this PR as it is": entail verifies the same head again and merges it.
    - The owner's own words, such as "go ahead, but don't touch X": entail writes a new version of the criteria with that fence, and the ticket goes back to cleared.
    - "Don't go ahead": the ticket is cancelled and the issue closed (ADR-0008).
  - A new push to the PR withdraws the item, as any stale item is withdrawn, and the landing check runs again.
- **Shadow** (owner). In a repo set to shadow (off by default), a passing PR gets the same landing comment, ending "would merge at `<sha>`; this repo is in shadow, so the merge is left to the owner". entail records this as a call and does not merge.
  - Nothing goes on the board and no notice is sent, because merging checked work is not a product decision and VISION.md resists work-management traffic on the board. The Calls page can filter to these calls.
  - The owner merges by hand on the forge, and entail records the ticket as merged. The same happens if the owner merges a PR that failed.
  - Moving a repo between shadow and automatic is a settings change, decided with the other per-repo settings.
- **The merge.**
  - entail merges through the API with the head sha pinned: GitHub's merge endpoint with `sha`, and GitLab's merge endpoint with `sha`.
  - It uses the repo's default merge method.
  - It never uses an admin override. If the forge refuses the merge, for example because of a required review, a merge queue or a protection rule, the ticket stays landing, and the PR gets one comment saying the forge refused the merge and why.
  - If the forge does not close the issue on merge, for example because GitLab's auto-close is off, entail closes it as part of the merged call and removes `entail:cleared` (ADR-0013).
- **Several PRs for one ticket.** Each is checked on its own against the same frozen criteria, and the first to pass merges. entail then comments once on each other open PR linking the ticket that the ticket is already merged, and stops checking them. It does not close them.
- **One PR linking several tickets.** It merges only when it passes the criteria of every ticket it links. If any linked issue has no criteria in force, it does not merge, and the landing comment says so.
- **A PR closed without merging.** The ticket goes back to cleared if no other PR for it is open.
- **Cost.** A passing PR costs two model runs, the grader and the challenge, at each head that reaches grading.
- Decided on [How does entail verify a landed PR's evidence, and how is a failing PR routed?](https://github.com/omkarbhale/entail/issues/22).

## Amendment: VISION.md now says entail comments, never fixes

VISION.md said that when a PR fails its criteria, entail decides whether to fix it itself, raise it again, or cancel it, which contradicted entail never executing ([#24](https://github.com/omkarbhale/entail/issues/24)). The owner amended the line: entail decides whether to comment on the PR with what needs to change, raise it again, or cancel it, and it never fixes the PR itself. The failing landing comment is that comment. Raising a failing PR again and cancelling it remain the later routing effort named above.
