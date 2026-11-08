import { markedTickets } from "./comment-rules.ts";
import { sameActor, type Change, type Forge } from "./forge/forge.ts";
import { repoOwner } from "./intake.ts";
import type { OperationalLog } from "./operational-log.ts";
import { readRepoSettings } from "./repo-settings.ts";
import type { FreshStartRecord, RepoRecord, Store } from "./store.ts";

/**
 * Where an enrolled repo stands on the check for marked issues with no
 * records (spec §3 "Starting without records", ADR-0009):
 *
 * - `unchecked`: not checked yet in this process, or the check could not read
 *   the forge; entail does nothing in the repo until the check passes.
 * - `clear`: every issue carrying entail's hidden marker has its records, or
 *   was left alone at a fresh start.
 * - `missing`: issues carry the marker with no records behind them. This is
 *   the repo halt: entail does nothing in the repo until the owner restores
 *   the records repo or confirms a fresh start.
 */
export type RecordsStanding =
  | { status: "unchecked"; lastError: string | null }
  | { status: "clear"; checkedAt: string }
  | { status: "missing"; since: string; markedIssues: number[] };

/**
 * The issues among `changes` that carry entail's hidden marker with no
 * records behind it, in number order.
 *
 * A marker counts only on an issue comment by the repo's owner, compared by
 * numeric id: entail posts through the owner's own CLI, so a marker anyone
 * else wrote is not entail's. A marker has its records when the store holds
 * the ticket it names, on this repo and this issue. An issue a fresh start
 * left alone is not missing records, whatever it carries.
 */
export function markedIssuesWithoutRecords(store: Store, repo: RepoRecord, changes: readonly Change[]): number[] {
  const owner = repoOwner(repo);
  const missing = new Set<number>();
  for (const change of changes) {
    if (change.kind !== "issue-comment") continue;
    const { comment } = change;
    if (!sameActor(comment.author, owner) || missing.has(comment.issueNumber)) continue;
    const unrecorded = markedTickets(comment.body).some((ticketId) => {
      const ticket = store.getTicket(ticketId);
      return ticket === null || ticket.repoId !== repo.id || ticket.issueNumber !== comment.issueNumber;
    });
    if (unrecorded && !store.leftAloneAtFreshStart(repo.id, comment.issueNumber)) missing.add(comment.issueNumber);
  }
  return [...missing].sort((a, b) => a - b);
}

export interface RecordsCheckOptions {
  store: Store;
  /** The forge adapter the check reads a repo's issues through. */
  forgeFor: (repo: RepoRecord) => Forge;
  log?: OperationalLog;
  now?: () => Date;
}

/**
 * The check for marked issues with no records, and the repo halt it raises
 * (spec §1 "Start" step 5, §3, §16; ADR-0009, ADR-0019).
 *
 * It runs at start, before unconfirmed intents are settled, and at
 * enrollment; a repo it could not check then is checked on its next pass. The
 * check is one read of everything the forge holds for the repo's issues and
 * their comments, and nothing else: until it is clear, entail makes no other
 * forge read or write in the repo.
 *
 * A repo found missing records stays halted for the life of the process,
 * because only the owner can clear it: restoring the records repo (with
 * entail stopped, so the next start checks the restored store) or confirming
 * a fresh start, which {@link RecordsCheck.confirmFreshStart} records.
 *
 * Standings are kept in memory, not in the records: the halt is not a call
 * (ADR-0019), and the next start checks again.
 */
export class RecordsCheck {
  readonly #options: RecordsCheckOptions;
  readonly #standings = new Map<number, RecordsStanding>();
  readonly #checking = new Map<number, Promise<RecordsStanding>>();

  constructor(options: RecordsCheckOptions) {
    this.#options = options;
  }

  /** Where the repo stands: unchecked until a check of it has read the forge. */
  standing(repoId: number): RecordsStanding {
    return this.#standings.get(repoId) ?? { status: "unchecked", lastError: null };
  }

  /** Whether entail may read and write in the repo: only once the check found its records. */
  mayAct(repoId: number): boolean {
    return this.standing(repoId).status === "clear";
  }

  /**
   * Checks the repo, unless a check already settled it in this process: a
   * repo found clear or missing records keeps that standing. A check already
   * running for the repo is shared rather than run twice.
   *
   * @throws whatever the forge read threw, such as a rate limit or a
   *   logged-out CLI; the repo stays unchecked, with the error kept.
   */
  check(repo: RepoRecord): Promise<RecordsStanding> {
    const settled = this.#standings.get(repo.id);
    if (settled && settled.status !== "unchecked") return Promise.resolve(settled);
    let running = this.#checking.get(repo.id);
    if (!running) {
      running = this.#check(repo).finally(() => this.#checking.delete(repo.id));
      this.#checking.set(repo.id, running);
    }
    return running;
  }

  /**
   * Records the fresh start the owner confirmed for a repo missing records,
   * leaving every issue the check found marked alone for good, and lets
   * entail act in the repo again. Returns null, recording nothing, when the
   * repo is not missing records.
   */
  confirmFreshStart(repoId: number, confirmedBy: string): FreshStartRecord | null {
    const standing = this.standing(repoId);
    if (standing.status !== "missing") return null;
    const { store, log } = this.#options;
    const freshStart = store.recordFreshStart({ repoId, confirmedBy, markedIssueNumbers: standing.markedIssues });
    this.#standings.set(repoId, { status: "clear", checkedAt: freshStart.confirmedAt });
    log?.info("fresh-start-confirmed", { repoId, freshStartId: freshStart.id, markedIssues: standing.markedIssues.length });
    return freshStart;
  }

  async #check(repo: RepoRecord): Promise<RecordsStanding> {
    const { store, forgeFor, log } = this.#options;
    const now = () => (this.#options.now?.() ?? new Date()).toISOString();
    let changes: Change[];
    try {
      changes = (await forgeFor(repo).changesSince(null)).changes;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#standings.set(repo.id, { status: "unchecked", lastError: message });
      log?.warn("records-check-failed", { repoId: repo.id, error: message });
      throw error;
    }
    const markedIssues = markedIssuesWithoutRecords(store, repo, changes);
    const standing: RecordsStanding =
      markedIssues.length === 0 ? { status: "clear", checkedAt: now() } : { status: "missing", since: now(), markedIssues };
    this.#standings.set(repo.id, standing);
    if (standing.status === "missing") {
      log?.error("records-missing", { repoId: repo.id, path: repo.path, host: repo.host, markedIssues });
    } else {
      log?.info("records-check-clear", { repoId: repo.id });
    }
    return standing;
  }
}

/**
 * Runs the check for every enrolled repo, side by side, as entail starts. A
 * repo whose check fails stays unchecked, and its pass checks it again; the
 * failure is logged by the check, so nothing here throws. An unenrolled repo
 * is never read, and a paused one is checked by its first pass after it is
 * resumed (ADR-0018).
 */
export async function checkEveryRepo(store: Store, check: RecordsCheck): Promise<void> {
  const repos = store.listEnrolledRepos().filter((repo) => readRepoSettings(store, repo.id)?.settings.paused !== true);
  await Promise.all(repos.map((repo) => check.check(repo).catch(() => undefined)));
}
