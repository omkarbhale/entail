# feat: label an issue entail:raised while its ticket waits on the board

Closes #168

## entail evidence

C1: Added `entail:raised` (`src/intake-comment.ts`), mapped to the on-the-board state in `LABEL_IN_STATE` (`src/pull-requests.ts`). `raiseToBoard` (`src/board-item.ts`) records the add with the raise call and sends it last, after any earlier label such as `entail:cleared` is removed. Every call that takes a ticket off the board records and sends the removal: answers (`src/after-answer.ts`, and `src/merge.ts` for "Merge this PR as it is", merged or refused), withdrawals (`src/issue-edit.ts`, `src/recheck.ts`, and `src/landing-pin.ts` for a new push) and cancels (outside close, unenroll, merged by others, through `LABEL_IN_STATE`). Where the ticket goes back to landing or is cleared, `entail:cleared` goes on only after `entail:raised` comes off. The PR changes `src/**` and does not change `VISION.md` — the full suite (`npm test`) passes with 943 tests and 0 failures.
C2: The label is a fixed name with no question text, and entail does not react to label changes. The new test "entail:raised only marks state: adding or removing it by hand answers nothing and moves nothing" (`test/after-answer.test.ts`) removes and re-adds the label by hand on the forge: the ticket stays on the board, its item stays open with no answer, and no call or comment is made. ADR-0013 and `docs/spec/mvp-1.md` say the label only marks state. `VISION.md` is unchanged — the test passes.
C3: Tests cover adding the label on raise (`test/board-item.test.ts`, `test/criteria.test.ts`, `test/investigation.test.ts`, `test/landing-pin.test.ts`, `test/recheck.test.ts`). They cover removal on an answer: going ahead (then `entail:cleared` on clear), "don't go ahead", and "Merge this PR as it is" merged or refused (`test/after-answer.test.ts`, `test/landing-pin.test.ts`, `test/recheck.test.ts`). They cover removal on a withdrawal: issue edit, vision change and new push (`test/recheck.test.ts`, `test/landing-pin.test.ts`). They cover removal on a cancel: issue closed, unenrolled, merged by others (`test/outside-close.test.ts`, `test/repo-switches.test.ts`, `test/repo-switches-page.test.ts`, `test/pull-requests.test.ts`). The PR changes `test/**` and not `VISION.md` — `npm test` passes: 943 tests, 0 failures.
G1: GitHub Actions check `test (ubuntu-latest)` ran at head c2582cbf97d3609dab8d8e4a51e5cee06d7e669a — pass.
G2: GitHub Actions check `test (macos-latest)` ran at head c2582cbf97d3609dab8d8e4a51e5cee06d7e669a — pass.

## Intent

"you can pick the other two and raise PR for them after no-mistakes run."

Build https://github.com/omkarbhale/entail/issues/168 ("I want entail to mark issues not just cleared, but raised as well."). entail itself cleared this issue and posted its criteria in its latest "Speaking from Omkar's entail:" comment on the issue (Criteria C1.. and generic criteria G1, G2). Those criteria are the contract for this PR. They are:
- C1: While an issue's ticket is on the board waiting for the owner, the issue carries an `entail:raised` label on the forge, and that label is removed when the board item is answered, withdrawn or cancelled (replaced by `entail:cleared` if the ticket is then cleared), so an issue never carries `entail:raised` alongside another entail state label. Mechanical checks: the PR changes a file matching `src/**`; the PR changes no file matching `VISION.md`.
- C2: The `entail:raised` label only marks state: it carries no question text and adding or removing it by hand answers nothing, so the question and its answer stay on the board. Mechanical check: the PR changes no file matching `VISION.md`.
- C3: The repo's tests cover the `entail:raised` label being put on an issue when its ticket is raised and taken off when the board item is answered, withdrawn or cancelled. Mechanical checks: the PR changes a file matching `test/**`; the PR changes no file matching `VISION.md`.
- G1: The check `test (ubuntu-latest)` passes.
- G2: The check `test (macos-latest)` passes.
entail's reading chosen: add an `entail:raised` label that entail puts on an issue while its ticket is on the board waiting for the owner, and removes when the ticket leaves the board, following the existing one-label-per-state rule used for `entail:cleared` and `entail:investigate`.

## What Changed
- Adds an `entail:raised` label (`RAISED_LABEL` in `src/intake-comment.ts`, mapped to the `on-the-board` state in `LABEL_IN_STATE`). `raiseToBoard` records an add-label intent in the same transaction as the board item and sends it after any label the ticket carried before is removed, so the issue never holds two `entail:` labels.
- Removes the label, with the intent recorded in the same transaction, whenever the ticket leaves the board: owner answer (`after-answer.ts`), withdrawal by an issue edit (`issue-edit.ts`, `recheck.ts`), a vision or pin change, or a new push to a landing PR. A refused landing-pin merge and a merge on the owner's answer also drop it, and the former swaps in `entail:cleared`. The label carries no question text, and answers still come only through the board form.
- Updates ADR-0013 and `docs/spec/mvp-1.md` to describe the new label. Adds tests in `test/after-answer.test.ts`, `test/recheck.test.ts` and `test/landing-pin.test.ts`, and adjusts existing board, criteria, investigation, outside-close, pull-requests and repo-switches tests for the added label writes.

## Risk Assessment

✅ Low: The change follows the existing one-label-per-state pattern, and every path that takes a ticket off the board (answer, merge, refusal, new push, edit, vision or pin change, outside close, unenroll) removes `entail:raised`, with its intent recorded in the same transaction as the call.

## Testing

I ran the seven affected test files, 120 tests in all, and all passed. They run entail's real code against a fake forge. I did not start entail itself against a real forge, and the acceptance harness was not run, so no scenario is marked live.

- Live validation: ⚠️ inconclusive - 0 of 4 scenarios driven live against the product

| Scenario | Result | Live | Evidence |
| --- | --- | --- | --- |
| Raising a ticket puts entail:raised on the issue; going ahead removes it before entail:cleared goes on | ⏸️ untested | no | The prior payload recorded only fake-forge unit tests (test/after-answer.test.ts) and did not drive this against a live forge, so it established no live result. |
| &#34;Don&#39;t go ahead&#34; removes entail:raised from the closed issue | ⏸️ untested | no | The prior payload recorded only fake-forge unit tests (test/after-answer.test.ts) and did not drive this against a live forge, so it established no live result. |
| Adding or removing entail:raised by hand answers nothing and moves nothing | ⏸️ untested | no | The prior payload recorded only fake-forge unit tests (test/after-answer.test.ts) and did not drive this against a live forge, so it established no live result. |
| An edit withdrawing a board item, or unenrolling the repo, removes entail:raised | ⏸️ untested | no | The prior payload recorded only fake-forge unit tests (test/recheck.test.ts, test/repo-switches.test.ts) and did not drive this against a live forge, so it established no live result. |

- Outcome: ⚠️ 1 warning across 1 run (56.4s)

[The no-mistakes pipeline report that followed in the description is left out.]
