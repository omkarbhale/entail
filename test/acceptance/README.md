# Acceptance harness

MVP-1's acceptance test, and the parts of it that do not need entail to be finished ([ADR-0010](../../docs/adr/0010-the-acceptance-test-runs-on-fixture-repos-and-fails-on-any-wrong-clear.md), [MVP-1 spec](../../docs/spec/mvp-1.md), Testing Decisions). The runs and pass checks build on it.

- **The fixture.** `fixture/tally/` is the starting tree of `tally`, a word-count command-line tool in Node, tested with `node --test`, with one CI job named `test` on GitHub Actions and on GitLab CI. `fixture.ts` holds its issues T1–T13 with their expected paths and end states, and the repo settings it is enrolled with.
- **Prepared work.** `prepared.ts` holds a prepared change for every ticket expected to merge (T1's first push fails CI and a second push fixes it; T11 and T13 each bring tally to the vision's whole word rule, so whichever merges second only adds its tests), the findings for T11, and the owner's answers for T7, T9 and T13. T8 is left unanswered. Extra board items on tickets expected to merge get an answer that keeps them on the way to merged, and are reported.
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

- **One run per fixture at a time.** `setup`, `reset`, `executor`, `play` and the acceptance test hold an exclusive lock on each fixture repo they use, a file per forge and repo under `$XDG_STATE_HOME/entail-acceptance/locks/` (`~/.local/state/…`, or `ENTAIL_ACCEPTANCE_LOCK_DIR`) recording the holder's pid, host, start time and command. While another run or reset holds it they refuse to start and name the holder. An interrupt (Ctrl-C, SIGTERM) stops the acceptance test's entail and releases its locks; a lock is left behind only when the process is killed outright (SIGKILL, a crash) and stays until it is broken with `--break-lock`, which never takes the lock of a holder still running on this host.
- **Never inside a review pipeline.** Every command but `check` refuses to run when `NO_MISTAKES_GATE` is set. `npm test` runs only the harness's own tests, against an in-memory forge; live runs go only through the commands here, run by hand.

- **The reset** closes (GitHub) or deletes (GitLab) PRs, deletes every branch but `main`, force-pushes the starting commit (built with a fixed date and identity, so it is the same commit every time), deletes every issue, comment and `entail:` label, and files T1–T13 again in order.
- **The scripted executor** reacts only to `entail:cleared` and `entail:investigate`. For a cleared issue it opens the prepared PR with `Closes #<n>` and an `entail evidence` section holding one entry per C and G id in entail's latest criteria comment, with the result of running tally's tests at that head. For an investigated issue it posts one `entail findings` comment with an entry per Q id. It pushes T1's fix once entail's landing comment names the failing head, rebuilds a PR the forge reports in conflict on the new default branch, and posts evidence again when the head or the criteria change. It keeps no state: every pass re-reads the forge.
- **The board driver** reads the board page and the item pages it links to, fills each answer form, presses "Review answer" and then "Record answer as <owner> (final)", sending back the form's own hidden fields, the per-start token and item version among them, with the board's `Origin`. It never writes to entail's store.

## The acceptance test

```sh
npm run acceptance                               # 3 runs on GitHub, 1 on gitlab.com
npm run acceptance -- --forge github             # GitHub only
npm run acceptance -- --recheck <out>            # the pass checks again, on a finished test's saved evidence
```

Each run resets the fixture repo without its issues, starts a fresh entail from the sources with a data directory of its own (`XDG_DATA_HOME` under the output directory) and the real model runner, and sets it up as the owner does, through its pages: the display name, the `file` notice connector, a 45-second poll interval and a model run limit of 3 on the global settings page; then the Repos page with the fixture's settings (the generic criterion "The CI job `test` passes." in place of whatever entail proposes, the vision's origin stated by the owner, shadow off) and the pin "the output format" on `src/format.js`. Only then does it file T1–T13, since entail takes in only issues opened after enrolling. The scripted executor (one pass a minute by default, since each pass reads every open PR and the forge's API budget is per account) and the board driver play until every ticket is final or waits on the board for an answer nobody gives (T8), with every forge write entail recorded confirmed; entail is restarted once midway, when a ticket is landing and a board item has been answered (or after `--restart-after` minutes). A run that cannot settle ends once no ticket has changed state for `--stall-minutes` (30) after the restart, or at `--max-minutes` (180), and is reported as not settled.

After each run the harness reads the forge (issues, comments, label history, PRs with their comments and the checks at their head, VISION.md at every cited commit), entail's store (read only), the notices file, the Calls page and the records repo, and runs pass checks 1–9 of the spec. It prints a report per run and per ticket with the path each ticket took, its model runs and estimated cost, every check and every extra board item, then the passing rule across runs: no ticket expected to need the owner or to be declined is cleared without an answer in any run, each ticket expected to be cleared is cleared in at least 2 of 3 GitHub runs, and every pass check holds in every run. The report (`report.md`), the verdict and each run's evidence, events and entail log go to `--out` (by default a new directory under the system temp dir). Reports of graded runs are kept in [`reports/`](reports/).

The exit status is 0 when the test passed on both forges, 1 when it failed, 3 when it passed on GitHub and the gitlab.com run is pending because `glab` is missing or logged out, and 4 when runs are missing. entail's board port must be free: each run's entail serves on `127.0.0.1:7419`, or on `--port <n>` (saved to the run's fresh store before entail's first start) to run beside another test holding 7419.
