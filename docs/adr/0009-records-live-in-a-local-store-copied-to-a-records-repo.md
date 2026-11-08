# entail's records live in one local store, backed up to a records repo the owner chooses

entail keeps every record in one local SQLite database in its per-user data directory. That covers tickets and their state, calls, answers with their notes, vision line origins, vision changes and the comments it posted, for every enrolled repo. This store is the authority. Labels and comments on the forge are copies of it. Nothing goes into the project's repo. entail never pushes there. Repos may be public, so private notes and model outputs cannot go on an issue. Anyone with access can edit a forge comment, and every GitLab read costs a request.

Records are append-only, and the store itself refuses updates and deletes. A ticket's current state is the one row that changes, and only in the same transaction as the call that changes it. So the state never moves without a logged call, and VISION.md's "every verdict persists with its reason" is enforced by the store rather than by care.

So that the records survive a lost machine, entail commits a copy of them to a **records repo**. That is a git repository in its data directory, holding a text export of the store. entail commits after every answer and at least hourly, and pushes to whatever remote the owner configures: a local bare repo, GitHub, GitLab or anything else git can push to. The owner chose git, saying "origin can be anything, local bare, gh, etc". It needs no new service, keeps every past version, and lets the owner put the copy wherever they already keep things.

## Considered options

- **Append-only JSONL files per repo as the store**: rejected. They are readable and easy to grep, but they have no transactions, so a crash between a state change and its call could leave the two disagreeing. A text export is still what goes into the records repo, so its history shows each change.
- **The forge's issues and comments as the store** (labels, and hidden markers in comments): rejected for the reasons above.
- **Files committed to the project's repo**: rejected. entail never pushes there, and a public repo would expose private notes.
- **Snapshots copied to a synced backup folder**: offered, and passed over by the owner in favour of a git remote.
- **No built-in copy, relying on the owner's machine backups**: rejected. Answers and the reasoning behind each call cannot be rebuilt from anywhere else.

## Consequences

- **What a call records.** Every call records:
  - its ticket, repo, time, kind and reason;
  - its citation, or the answer it cites;
  - the results of its mechanical checks and its challenge;
  - the inputs it judged: the issue's title and body exactly as read, the vision sha, the pins and settings version, and the PR head sha for a landing check;
  - the full input and output of every model run behind it, with model, prompt version, session id, duration and estimated cost;
  - the forge comment it posted, by id and URL.

  An issue can be edited or deleted later, and an audit must show what the decider actually saw.
- **Machine failures are not calls.** Retries and machine failures (ADR-0002) go to a separate operational log, not the audit log.
- **Private records stay private.**
  - The records repo holds private notes and model outputs, so entail refuses to push to a remote it can verify is public, such as a public GitHub or GitLab project, and says so when the remote is first set up.
  - A remote whose visibility entail cannot check, such as a plain git URL or a local bare repo, is accepted.
  - A remote on the same machine does not survive losing that machine, and entail says so.
- **Restoring.** Restoring means cloning the records repo and importing it into a fresh store. Without a remote, commits stay local. entail shows when its last push succeeded.
- **Hidden marker.** Every comment entail posts carries a hidden marker with the ticket's record id, placed so that no line starts with `/`.
- **Starting without records.** If entail starts with no records for a repo whose issues carry that marker, it does nothing in that repo and says so until the owner restores the records repo or confirms a fresh start. A fresh start leaves every issue that already carries the marker alone and takes in only new ones.
- **Rebuildable records.** Vision line origins can also be rebuilt from the project's git history (ADR-0004's trailers) plus the enrollment origin in settings. Answers, notes, settings and the reasoning and model output behind each call exist only in the store and the records repo.
- **Auditing.**
  - The owner reads the audit log on a read-only Calls page, served by the same local process as the board but separate from board items. It lists every call newest first, filterable by repo, ticket, kind and date. Each call shows its reason, citation permalinks and check and challenge results, with links to the issue and PR, and its model input and output one click away.
  - Each ticket also has a page with its whole history, including answers attributed to whoever gave them.
  - The page asks nothing and changes nothing, so the board stays limited to product decisions.
- **Fixing a wrong call.** The Calls page offers no action. The owner fixes a wrong call through the paths that already exist: closing the issue, reverting the change, adding a vision line, or adding a pin so that kind of ticket comes to them next time. ADR-0008's single answer path stays the only way the owner's word enters entail.
- **Unenrolling** a repo keeps its records, read-only. Nothing is pruned in MVP-1.
- Decided on [Where does entail keep its records, and how does the owner audit them?](https://github.com/omkarbhale/entail/issues/26).
