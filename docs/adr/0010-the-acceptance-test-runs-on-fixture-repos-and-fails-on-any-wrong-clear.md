# MVP-1's acceptance test runs on fixture repos, and any wrong clear fails it

MVP-1's acceptance test is PROBLEM.md's: a small vision and a handful of tickets, some settled by it, some it is silent on and some contradicting it. It runs on a pair of private fixture repos, one on GitHub and one on gitlab.com, holding the same tiny made-up product (`tally`, a word-count command-line tool), its 9-line vision and a fixed set of issues. It does not run on entail's own repo. The owner chose this. A settled test ticket has to be a change the vision settles that is not yet built, and nobody can name such changes for entail's own repo before MVP-1 exists. A test that merges into entail's own default branch also cannot be run twice, and entail's VISION.md is not the "small vision" PROBLEM.md asks for. Dogfooding still comes first among real repos: entail's own repo is the first one enrolled, right after the test passes.

Passing is asymmetric, as VISION.md is: a wrong "already settled" is costly, while an extra question is cheap. The full set runs 3 times on GitHub. A ticket expected to need the owner, be declined or be ignored must never be cleared in any run, and a single wrong clear fails the test. A ticket expected to be cleared must be cleared in at least 2 of the 3 runs, and every extra board item is reported.

## Considered options

- **entail's own repo and its real VISION.md**: rejected by the owner for the reasons above.
- **Both: the fixture first, then a fixed number of real entail issues as part of the gate**: rejected. The real issues cannot be written down now.
- **One strict run, or 3 runs with every expected clear in all 3**: rejected by the owner. Model verdicts vary between runs, and VISION.md accepts an occasional extra question but never a wrong clear.

## Consequences

- **The executor.** entail never executes, so a scripted test executor plays the executor. It watches for `entail:cleared` and `entail:investigate`, opens a prepared PR for each cleared issue and posts prepared findings for each investigated one. The landing check is therefore tested independently of any agent's quality. No real executor, firstmate included, is needed, since entail must work without firstmate.
- **Answers.** The harness answers board items through the real board form on localhost, as the owner, so the single answer path is what the test exercises (ADR-0008). The test reruns unattended. The owner's first answers by hand come when they dogfood on entail's own repo.
- **Forges.** GitHub runs 3 times and gitlab.com runs once. On gitlab.com every ticket must reach its expected outcome or differ only by an extra question. Self-hosted GitLab is not part of the test. It shares gitlab.com's code path, and its own base URL is covered by unit tests.
- **The `/entail` rule.** No second forge account is used, so "nobody else's issue starts on its own unless `/entail` pulls it in" is covered by unit tests, not by the fixture.
- **What is checked.** Each run also restarts entail once midway. The harness checks the forge and entail's store for the following, and every check must hold:
  - every call is logged with its reason and inputs;
  - every citation quotes whole lines that appear word for word at the recorded sha;
  - nothing is invented: no criterion has an unknown source, and the vision is unchanged;
  - every comment entail posts follows the comment rules;
  - each board item raised produces one notice;
  - merges happen only at the head sha entail verified;
  - nothing is lost or duplicated across the restart.

  Each run reports its model runs and estimated cost, with no threshold in MVP-1.
- The fixture's vision, its tickets with their expected outcomes, and the pass checks are recorded on [What exactly is MVP-1's acceptance test?](https://github.com/omkarbhale/entail/issues/28), where this was decided.
