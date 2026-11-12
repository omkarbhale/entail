# Define the acceptance check for changes to how entail judges

`VISION.md` now says a change to how entail judges (its prompts, verdict rules or challenge) "is checked against the acceptance cases before it lands". It doesn't say what that check is. A full graded acceptance set (3 runs) takes about 3 hours per forge, which is too heavy to run for every judging change.

### Proposal

A judging change counts as checked when its PR shows all of the following:

1. **Unit tests on the tally acceptance cases** (scripted model runner) pass, including a test for the case the change fixes.
2. **One live graded acceptance run on the GitHub fixture** (`npm run acceptance -- --forge github`, 1 run), with:
   - its per-ticket results against the expected outcomes;
   - the wrong-clear count, which must be 0 (any wrong clear stops the change).
3. **The change's own explanation:** the case it fixes, what it could break, and why.

The full 3-run set on both forges stays a milestone gate (see #166), not something run for every judging change.

### Time and resources

**If an agent picks this up:** before starting, tell the operator this estimate, the expected CPU use and the environment requirements below.

- **Time:** about 45–60 minutes per live run (the executor polls about once a minute to stay inside the GitHub API budget). Unit tests take a few minutes.
- **CPU and memory:** light to moderate. One entail Node process, up to 2 concurrent `claude` CLI runs and the harness's scripted executor. Roughly 1–2 cores busy in bursts and about 1–2 GB of RAM.
- **Model usage:** about 55 model runs per live run, roughly $4 at API prices, charged to the operator's Claude subscription.
- **Environment:**
  - Linux (WSL included) or macOS, Node 24+ and `git`
  - `claude` logged in
  - `gh` logged in as the fixture owner, with access to the private GitHub tally fixture
  - port 7419 free
  - the fixture lock free; break it with `--break-lock` only if its holder is gone
  - the machine stays on for the whole run (a shutdown invalidates it)

### Estimate for doing this issue

About an hour of work to write the check into the spec and the acceptance README (and optionally a small `npm run acceptance:check-judging` wrapper), plus one live run (45–60 minutes) to prove it.
