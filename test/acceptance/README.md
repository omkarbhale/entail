# Acceptance harness

The parts of MVP-1's acceptance test that do not need entail to be finished ([ADR-0010](../../docs/adr/0010-the-acceptance-test-runs-on-fixture-repos-and-fails-on-any-wrong-clear.md), [MVP-1 spec](../../docs/spec/mvp-1.md), Testing Decisions). The runs and pass checks build on it.

- **The fixture.** `fixture/tally/` is the starting tree of `tally`, a word-count command-line tool in Node, tested with `node --test`, with one CI job named `test` on GitHub Actions and on GitLab CI. `fixture.ts` holds its issues T1–T13 with their expected paths and end states, and the repo settings it is enrolled with.
- **Prepared work.** `prepared.ts` holds a prepared change for every ticket expected to merge (T1's first push fails CI and a second push fixes it), the findings for T11, and the owner's answers for T7, T9 and T13. T8 is left unanswered. Extra board items on tickets expected to merge get an answer that keeps them on the way to merged, and are reported.
- **The fixture repos** are private, named `entail-fixture-tally` under the logged-in account on GitHub and on gitlab.com by default, with "entail acceptance fixture" in their description. The reset refuses any repo without that marker, any public repo and entail's own repo.

## Commands

```sh
npm run acceptance:harness -- setup          # create the repos if missing, then reset them
npm run acceptance:harness -- reset          # code, VISION.md, issues, labels, PRs and branches back to the start
npm run acceptance:harness -- check          # exit 1 and list what differs from the starting state
npm run acceptance:harness -- executor       # the scripted test executor
npm run acceptance:harness -- board-driver   # answers board items on http://127.0.0.1:7419/ as the owner
npm run acceptance:harness -- play           # the executor and the board driver together
```

`--forge github|gitlab|both` picks the repos (both by default), `--once` makes one pass, and `--events <file>` appends every event as a JSON line. The harness acts through the owner's `gh` and `glab`, which must be logged in.

- **The reset** closes (GitHub) or deletes (GitLab) PRs, deletes every branch but `main`, force-pushes the starting commit (built with a fixed date and identity, so it is the same commit every time), deletes every issue, comment and `entail:` label, and files T1–T13 again in order.
- **The scripted executor** reacts only to `entail:cleared` and `entail:investigate`. For a cleared issue it opens the prepared PR with `Closes #<n>` and an `entail evidence` section holding one entry per C and G id in entail's latest criteria comment, with the result of running tally's tests at that head. For an investigated issue it posts one `entail findings` comment with an entry per Q id. It pushes T1's fix once entail's landing comment names the failing head, rebuilds a PR the forge reports in conflict on the new default branch, and posts evidence again when the head or the criteria change. It keeps no state: every pass re-reads the forge.
- **The board driver** reads the board page and the item pages it links to, fills each answer form, presses "Review answer" and then "Record answer as <owner> (final)", sending back the form's own hidden fields, the per-start token and item version among them, with the board's `Origin`. It never writes to entail's store.
