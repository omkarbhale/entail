# entail shows its own health where the owner already looks, and interrupts only for halts the owner must fix

The running process can stop doing useful work without anything visibly failing:
- a self-hosted GitLab stops answering;
- a CLI is logged in as the wrong account;
- the subscription's usage limit is reached;
- the records repo stops pushing.

ADR-0017 logs all of these to the operational log, and ADR-0018's Repos page shows each repo's state. Neither tells the owner why decisions have stopped arriving. VISION.md keeps the board for product decisions only, and a change that "puts work-management traffic on the board" is resisted. So health has to be visible without becoming board items, issue comments or calls.

entail sorts what can go wrong into two kinds:
- a **halt** is work entail stops on its own because something outside it is wrong, and it clears by itself once that is fixed;
- a **warning** is work that continues but needs watching.

**Where health shows** (owner). While anything is halted or warned, a strip appears at the top of every page entail serves: the board, the Calls page, ticket pages and the Repos page.
- It shows one line per halt or warning: what is wrong, what it stops, since when, and what clears it. For example: "gitlab.example.com is not answering. 2 repos are not being read since 09:40. Retrying every 15 minutes."
- When all is well there is no strip, and the page header says only when the last pass ran.
- The Repos page shows the details per repo and per host.
- `entail status` shows the same in a terminal, even while entail is stopped.
- The strip is not a board item. It takes no answer and is not counted among the items waiting for the owner.

The board is where the owner looks, and a halt is exactly why items stop arriving or why an answer's comment has not been posted yet.

**What interrupts the owner** (owner). A desktop notice goes out only for a halt the owner must fix by hand, once when it begins. It does not repeat while the halt lasts, and nothing is sent when it clears. The conditions are:
- `git` or `claude` missing or logged out;
- a host's `gh` or `glab` logged out, or logged in as another account;
- a forge host that has not answered for an hour, which may mean a VPN is down or a token has expired;
- a repo waiting for its records to be restored or a fresh start confirmed;
- an enrolled repo whose VISION.md is gone or empty;
- no records push succeeding for 24 hours while a remote is set;
- entail stopping unexpectedly again and again.

The notice uses the same connector as the board-item notice (ADR-0017). It names the condition and links to the Repos page, and like that notice it carries no question and takes no answer. Waits that clear on their own never notify: a short backoff, a rate limit, the usage-limit pause and machine-failure retries. The usage-limit pause in particular is expected daily use of a shared subscription.

## Considered options

- **Health only on the Repos page and in `entail status`**: passed over by the owner. The owner would learn why decisions stopped arriving only by going to look.
- **A separate Status page with no strip**: passed over by the owner for the same reason.
- **No health notices at all**: passed over by the owner. A halt the owner must fix silently stops all work in its scope and could go unnoticed for days.
- **A notice for every halt and warning**: passed over by the owner. Waits that clear on their own would turn the notice into noise.

- **Exiting when a start-up check fails**, as ADR-0017 first said: replaced. Under the user service, an exit restarts straight into the same failure, and with no page served nothing says why.
- **Keeping halts and warnings as records, or in the store**: rejected. They are not calls, and the store is append-only (ADR-0009). A status file the next pass rewrites is enough.
- **Telling the forge, such as an issue comment saying entail is down**: rejected. During a host halt entail cannot post anyway, and elsewhere it would be work-management traffic on someone's issue.
- **A separate watchdog that notices when entail is not running**: out of MVP-1. The service restarts entail after a crash, and `entail status` says it is stopped.

## Consequences

- **Start-up checks no longer exit** (amends ADR-0017).
  - If `git` or `claude` is missing or logged out, `entail run` stays up and serves its pages with that halt shown.
  - It makes no forge reads or writes and starts no model runs. It re-checks on every pass and resumes by itself once the check passes. "Nothing runs" still holds for work.
  - Only failures that make the process itself impossible still exit, with a message on stderr and in the journal: the lock is held by another copy, the store cannot be opened, or the port is taken.
- **Failures while running.**
  - An authentication failure from `claude` is the all-of-entail halt, re-checked each pass, not a machine failure retried forever.
  - An authentication failure or a wrong account from `gh` or `glab` is that host's halt, not a backoff.
- **The halts.**

  | Halt | Scope | Clears when |
  | --- | --- | --- |
  | `git` or `claude` missing or logged out | all of entail | the check passes on a pass |
  | Subscription usage limit (ADR-0017) | all model work | the reset time `claude` reports, or 30 minutes |
  | `gh` or `glab` logged out, or logged in as another account | one host's repos | the check passes on a pass |
  | Host not answering for an hour | one host's repos | a poll succeeds |
  | Marked issues with no records (ADR-0009) | one repo | the owner restores the records or confirms a fresh start |
  | VISION.md gone or empty (ADR-0018) | one repo | a vision is back |

- **The warnings.**
  - **Records push.** No push has succeeded for 24 hours while a remote is set.
  - **No remote set.** This is a standing line on the global settings page and in `entail status`, never on the strip. ADR-0009 already says so when the remote is set up, and the owner may keep the copy local on purpose.
  - **Model runs failing.** A ticket's model step has failed for an hour in a row, or every model run has failed for 15 minutes. The warning says how many tickets are affected and the last error, never which tickets wait, and each ticket page shows its own retry state.
  - **Notices failing.** The last desktop notice failed. It shows only where the owner looks, since a notice cannot report its own failure.
  - **A repo backing off.** A repo has failed to poll for 15 minutes or more. Below that it is only logged, as ordinary network noise. At an hour it becomes the host-not-answering halt.
  - **An unexpected stop.** On start, entail finds the lock left behind by a process that no longer exists. It logs this and warns "entail restarted after an unexpected stop at <time>" until the end of the day. If three unexpected stops happen within 10 minutes, the starting process sends one desktop notice, "entail keeps stopping", before carrying on. The service manager's own restart limits still apply.
- **`entail status`** works whether or not entail is running. It prints:
  - whether entail is running, with its pid and start time, from the lock;
  - when the last pass ran;
  - every current halt and warning, with its onset time;
  - each repo's state and last successful poll;
  - when the last records push succeeded;
  - the last few warning lines from the operational log.

  It lists no tickets, because which work is waiting, ready or held is work management, which belongs to [Work management utility (separate project)](https://github.com/omkarbhale/entail/issues/33). It exits 0 when entail is running with no halt or warning, 1 when something is halted or warned, and 2 when entail is not running. `--json` prints the same as JSON for the owner's own scripts.
- **The status file.** The running process rewrites a small status file in the data directory on every pass, and `entail status` reads it. It is not part of the records and is not copied to the records repo. Losing it loses nothing, because the next pass rewrites it.
- **Health stays off the forge, off the board and out of the records.** No issue or PR gets a comment or label about a halt. A halt or warning is never a board item and never a call, and the operational log and the status file hold it.
- **Answering during a halt.**
  - During a model halt, the owner answers as usual. Writing criteria waits for the halt to clear.
  - During a host halt, that host's open board items lock with "entail cannot reach <host>", as ADR-0018 locks a paused repo's items. When the host answers again, catch-up runs before the forms unlock, so an answer is never recorded against a basis entail could not see change.
  - An answer recorded just before a halt keeps its issue comment as an intent, posted when the host is back (ADR-0017). The receipt says it will be posted when the host answers again.
- **Halt and paused differ.** Paused is the owner's setting (ADR-0018). A halt is never set by anyone and clears by itself. The Repos page shows the two apart.
- Decided on [How does the running process report its own health to the owner?](https://github.com/omkarbhale/entail/issues/49).
