import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { join } from "node:path";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION, type ANSWER_SHAPES, type FORGE_WRITE_KINDS, type VISION_ORIGINS } from "./store-schema.ts";
import { assertTransition, FINAL_STATES, type TicketState } from "./ticket-states.ts";

/** The store's file in the data directory. */
export const STORE_FILE = "store.sqlite";

export type Forge = "github" | "gitlab";

/**
 * What a call decided, by kind. Spec §3 lists at least these; a kind that
 * moves a ticket records the state change with the call.
 */
export const CALL_KINDS = [
  "intake",
  "verdict",
  "investigation",
  "criteria",
  "decline",
  "raise",
  "close-at-intake",
  "recheck",
  "landing",
  "would-merge",
  "merge",
  "cancel-on-outside-close",
  "unenroll-cancel",
] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export type VisionOrigin = (typeof VISION_ORIGINS)[number];
export type AnswerShape = (typeof ANSWER_SHAPES)[number];
export type ForgeWriteKind = (typeof FORGE_WRITE_KINDS)[number];

/** A repo is known by its forge, host and numeric project id, never its path. */
export interface RepoKey {
  forge: Forge;
  host: string;
  projectId: number;
}

export interface NewRepo extends RepoKey {
  /** The path the owner stated at enrollment; the repo may be renamed later. */
  path: string;
  ownerAccountId: number;
  ownerLogin: string;
}

export interface RepoRecord extends NewRepo {
  id: number;
  enrolledAt: string;
}

/** Everything enrolling a repo records, in one transaction (ADR-0018). */
export interface NewEnrollment {
  repo: NewRepo;
  /** The repo's first settings version. */
  settings: object;
  /** The owner's display name, recorded with the first settings version. */
  savedBy: string;
  /** The default branch commit whose VISION.md the owner reviewed. */
  visionSha: string;
  /** Every vision line of that VISION.md, recorded under {@link NewEnrollment.visionOrigin}. */
  visionLines: readonly string[];
  /** The one origin the owner confirmed for the existing VISION.md (ADR-0004). */
  visionOrigin: VisionOrigin;
  /** The issues open at enrollment, which are not taken in. */
  openIssueNumbers: readonly number[];
  /** The model runs enrolling made: the generic criteria proposal, when one was run. */
  modelRuns?: readonly NewEnrollmentModelRun[];
}

/**
 * A model run enrolling made, which belongs to no ticket and so to no call
 * (spec §15 step 4). A failed run keeps its failure in place of an output.
 */
export interface NewEnrollmentModelRun {
  /** The run's kind, such as `generic-criteria-proposal`. */
  purpose: string;
  model: string;
  promptVersion: string;
  sessionId: string | null;
  /** The run's full input. */
  input: string;
  /** The run's full structured output, or null when it failed. */
  output: string | null;
  /** The machine failure, or null when the run produced an output. */
  failure: unknown;
  startedAt: string;
  durationMs: number;
  /** null when the run reported no cost. */
  estimatedCostUsd: number | null;
}

export interface EnrollmentModelRunRecord extends NewEnrollmentModelRun {
  id: number;
  enrollmentId: number;
}

export interface EnrollmentRecord {
  id: number;
  repoId: number;
  enrolledAt: string;
  visionSha: string;
  settingsVersionId: number;
  openIssueNumbers: number[];
}

export interface SettingsVersionRecord {
  id: number;
  repoId: number;
  version: number;
  savedAt: string;
  /** The owner's name as recorded with the save. */
  savedBy: string;
  settings: unknown;
}

/** One saved version of entail's global settings (spec §15). */
export interface GlobalSettingsVersionRecord {
  id: number;
  version: number;
  savedAt: string;
  /** The owner's name as recorded with the save. */
  savedBy: string;
  settings: unknown;
}

export interface NewTicket {
  repoId: number;
  issueNumber: number;
  /** The issue's latest ticket, when it is pulled in again after that one ended (ADR-0020). */
  predecessorId?: number | null;
}

export interface TicketRecord {
  id: number;
  repoId: number;
  issueNumber: number;
  predecessorId: number | null;
  takenInAt: string;
  state: TicketState;
  /** The call that last changed the state; null while it is still the state the ticket was taken in with. */
  stateCallId: number | null;
  stateChangedAt: string;
}

/** Whole vision lines, word for word, at the vision's commit. */
export interface Citation {
  visionSha: string;
  lines: string[];
}

/** What a call judged, exactly as read, so an audit shows what entail saw. */
export interface JudgedInputs {
  issueTitle?: string | null;
  issueBody?: string | null;
  visionSha?: string | null;
  pins?: unknown;
  settingsVersionId?: number | null;
  /** The PR head a landing check judged. */
  prHeadSha?: string | null;
}

export interface NewModelRun {
  /** What the run was for, such as `verdict`, `challenge`, `criteria` or `grade`. */
  purpose: string;
  model: string;
  promptVersion: string;
  sessionId?: string | null;
  /** The run's full input. */
  input: string;
  /** The run's full output. */
  output: string;
  startedAt: string;
  durationMs: number;
  estimatedCostUsd: number;
}

export interface ModelRunRecord extends Required<NewModelRun> {
  id: number;
  callId: number;
}

export interface NewCall {
  ticketId: number;
  kind: CallKind;
  reason: string;
  citation?: Citation | null;
  /** The answer this call cites (ADR-0008). */
  answerId?: number | null;
  /** An unopposed clear: the vision is silent and nothing opposes the ticket (ADR-0011). */
  noContradictionFound?: boolean;
  /** The results of the call's mechanical checks. */
  checks?: unknown;
  /** The result of the call's challenge. */
  challenge?: unknown;
  inputs?: JudgedInputs | null;
  /** What the call decided, in the shape its kind defines (a verdict, criteria, findings questions…). */
  detail?: unknown;
  /** The state the call moves its ticket to; omitted when the state stays as it is. */
  stateTo?: TicketState;
  /** Every model run behind the call. */
  modelRuns?: NewModelRun[];
}

/** A comment entail posted for a call, once its forge write was confirmed. */
export interface PostedComment {
  intentId: number;
  commentId: string;
  commentUrl: string;
  confirmedAt: string;
}

export interface CallRecord {
  id: number;
  ticketId: number;
  repoId: number;
  madeAt: string;
  kind: CallKind;
  reason: string;
  citation: Citation | null;
  answerId: number | null;
  noContradictionFound: boolean;
  checks: unknown;
  challenge: unknown;
  inputs: JudgedInputs | null;
  detail: unknown;
  stateChange: { from: TicketState; to: TicketState } | null;
  modelRuns: ModelRunRecord[];
  postedComments: PostedComment[];
}

export interface NewBoardItem {
  ticketId: number;
  /** The call that put the ticket on the board. */
  callId: number;
  /** The decision, one sentence. */
  decision: string;
  /** Why it was raised: a contradiction, consequential readings, a pin or a failed check. */
  whyRaised: string;
  /** The item as raised: its parts and options (spec §13). */
  snapshot: unknown;
}

export interface BoardItemRecord extends NewBoardItem {
  id: number;
  raisedAt: string;
}

export interface NewAnswer {
  boardItemId: number;
  /** Whoever gave the answer. */
  answeredBy: string;
  shape: AnswerShape;
  /** The option chosen, for an `option` answer. */
  optionId?: string | null;
  /** The owner's own words, for an `own-words` answer. */
  text?: string | null;
  note?: string | null;
  showNoteOnIssue?: boolean;
}

export interface AnswerRecord {
  id: number;
  boardItemId: number;
  answeredAt: string;
  answeredBy: string;
  shape: AnswerShape;
  optionId: string | null;
  text: string | null;
  note: string | null;
  showNoteOnIssue: boolean;
}

/** Why and when an open board item was withdrawn, and by which call. */
export interface WithdrawalRecord {
  boardItemId: number;
  callId: number;
  withdrawnAt: string;
  reason: string;
}

/** A board item with how it ended: answered, withdrawn, or neither while it is open. */
export interface BoardItemHistory {
  item: BoardItemRecord;
  answer: AnswerRecord | null;
  withdrawal: WithdrawalRecord | null;
}

/**
 * Which calls to list. Every part is optional and they combine. Days are
 * `YYYY-MM-DD` in UTC, as calls' times are stored, and both ends are included.
 */
export interface CallFilter {
  repoId?: number;
  ticketId?: number;
  kind?: string;
  fromDay?: string;
  toDay?: string;
}

export interface NewWithdrawal {
  boardItemId: number;
  /** The call that takes the ticket off the board: deciding it again, cancelling it or checking it again. */
  callId: number;
  reason: string;
}

export interface NewVisionLineOrigin {
  repoId: number;
  line: string;
  origin: VisionOrigin;
  /** The commit that added the line, or the vision's commit at enrollment. */
  commitSha: string;
  /** A `Vision-Origin` trailer, a commit without one (stated by the owner), or the enrollment choice. */
  source: "trailer" | "no-trailer" | "enrollment";
}

export interface VisionLineOriginRecord extends NewVisionLineOrigin {
  id: number;
  recordedAt: string;
}

export interface NewVisionChange {
  repoId: number;
  commitSha: string;
  blobSha: string;
  previousBlobSha: string | null;
  removed: string[];
  added: string[];
}

export interface VisionChangeRecord extends NewVisionChange {
  id: number;
  seenAt: string;
}

export interface NewForgeWriteIntent {
  repoId: number;
  ticketId?: number | null;
  /** The call the write carries out, such as the call whose comment it posts. */
  callId?: number | null;
  kind: ForgeWriteKind;
  target: "issue" | "pr";
  number: number;
  payload: unknown;
}

export interface ForgeWriteIntentRecord {
  id: number;
  repoId: number;
  ticketId: number | null;
  callId: number | null;
  kind: ForgeWriteKind;
  target: "issue" | "pr";
  number: number;
  payload: unknown;
  recordedAt: string;
}

export interface ForgeWriteConfirmation {
  intentId: number;
  /** For a comment: its forge id and URL. */
  comment?: { id: string; url: string } | null;
  result?: unknown;
}

/** The store could not be opened or created. */
export class StoreOpenError extends Error {
  readonly path: string;
  constructor(path: string, why: string, options?: ErrorOptions) {
    super(`cannot open the store at ${path}: ${why}`, options);
    this.name = "StoreOpenError";
    this.path = path;
  }
}

export interface StoreOptions {
  now?: () => Date;
}

type Row = Record<string, SQLOutputValue>;

/**
 * entail's one local store: a SQLite database in the data directory holding
 * the records of every enrolled repo (ADR-0009).
 *
 * The store is append-only. Its integrity rules are enforced by the database
 * itself (see `store-schema.ts`), so they hold for any code that writes it.
 */
export class Store {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  #depth = 0;

  private constructor(path: string, db: DatabaseSync, now: () => Date) {
    this.path = path;
    this.#db = db;
    this.#now = now;
  }

  /** Opens the store at `path`, creating it if missing. Throws {@link StoreOpenError}. */
  static open(path: string, options: StoreOptions = {}): Store {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
      db.exec("PRAGMA journal_mode = WAL");
      // Makes INSERT OR REPLACE fire the delete triggers that refuse it.
      db.exec("PRAGMA recursive_triggers = ON");
      migrate(db, path);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // already failing
      }
      if (error instanceof StoreOpenError) throw error;
      throw new StoreOpenError(path, error instanceof Error ? error.message : String(error), { cause: error });
    }
    return new Store(path, db, options.now ?? (() => new Date()));
  }

  /** Opens the store in the data directory. */
  static openIn(dataDirectory: string, options?: StoreOptions): Store {
    return Store.open(join(dataDirectory, STORE_FILE), options);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  /** Runs `fn` in one transaction; nested calls join it through a savepoint. */
  transaction<T>(fn: () => T): T {
    const savepoint = `entail_${this.#depth}`;
    this.#db.exec(this.#depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  // Repos and settings

  enrollRepo(repo: NewRepo): RepoRecord {
    const id = this.#insert(
      "INSERT INTO repos (forge, host, project_id, path, owner_account_id, owner_login, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      repo.forge,
      repo.host,
      repo.projectId,
      repo.path,
      repo.ownerAccountId,
      repo.ownerLogin,
      this.#time(),
    );
    return this.getRepo(id)!;
  }

  /**
   * Enrolls a repo: records it, its first settings version, the origin of
   * every existing vision line and the issues open at enrollment, all in one
   * transaction, so a refused enrollment records nothing (ADR-0018).
   */
  enroll(enrollment: NewEnrollment): { repo: RepoRecord; settings: SettingsVersionRecord; enrollment: EnrollmentRecord } {
    return this.transaction(() => {
      const repo = this.enrollRepo(enrollment.repo);
      const settings = this.saveSettings(repo.id, enrollment.settings, enrollment.savedBy);
      for (const line of new Set(enrollment.visionLines)) {
        this.recordVisionLineOrigin({
          repoId: repo.id,
          line,
          origin: enrollment.visionOrigin,
          commitSha: enrollment.visionSha,
          source: "enrollment",
        });
      }
      const id = this.#insert(
        "INSERT INTO enrollments (repo_id, enrolled_at, vision_sha, settings_version_id, open_issue_numbers) VALUES (?, ?, ?, ?, ?)",
        repo.id,
        repo.enrolledAt,
        enrollment.visionSha,
        settings.id,
        JSON.stringify([...new Set(enrollment.openIssueNumbers)].sort((a, b) => a - b)),
      );
      for (const run of enrollment.modelRuns ?? []) {
        this.#insert(
          `INSERT INTO enrollment_model_runs (enrollment_id, purpose, model, prompt_version, session_id, input, output, failure,
             started_at, duration_ms, estimated_cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          run.purpose,
          run.model,
          run.promptVersion,
          run.sessionId,
          run.input,
          run.output,
          run.failure === null || run.failure === undefined ? null : JSON.stringify(run.failure),
          run.startedAt,
          run.durationMs,
          run.estimatedCostUsd,
        );
      }
      return { repo, settings, enrollment: mapOrNull(this.#get("SELECT * FROM enrollments WHERE id = ?", id), toEnrollment)! };
    });
  }

  /** The repo's latest enrollment. */
  latestEnrollment(repoId: number): EnrollmentRecord | null {
    return mapOrNull(this.#get("SELECT * FROM enrollments WHERE repo_id = ? ORDER BY id DESC LIMIT 1", repoId), toEnrollment);
  }

  /** The model runs an enrollment made, oldest first. */
  enrollmentModelRuns(enrollmentId: number): EnrollmentModelRunRecord[] {
    return this.#all("SELECT * FROM enrollment_model_runs WHERE enrollment_id = ? ORDER BY id", enrollmentId).map(toEnrollmentModelRun);
  }

  /** Whether an issue was open when the repo was last enrolled, so it is not taken in on its own (ADR-0018). */
  wasOpenAtEnrollment(repoId: number, issueNumber: number): boolean {
    const row = this.#get(
      `SELECT 1 AS open FROM enrollments e, json_each(e.open_issue_numbers) n
       WHERE e.id = (SELECT max(id) FROM enrollments WHERE repo_id = ?) AND n.value = ?`,
      repoId,
      issueNumber,
    );
    return row !== undefined;
  }

  /** Every enrolled repo, in the order they were enrolled. */
  listRepos(): RepoRecord[] {
    return this.#all("SELECT * FROM repos ORDER BY id").map(toRepo);
  }

  getRepo(id: number): RepoRecord | null {
    return mapOrNull(this.#get("SELECT * FROM repos WHERE id = ?", id), toRepo);
  }

  findRepo(key: RepoKey): RepoRecord | null {
    return mapOrNull(
      this.#get("SELECT * FROM repos WHERE forge = ? AND host = ? AND project_id = ?", key.forge, key.host, key.projectId),
      toRepo,
    );
  }

  /** Saves a new settings version for a repo. A save is not a call (ADR-0018). */
  saveSettings(repoId: number, settings: unknown, savedBy: string): SettingsVersionRecord {
    return this.transaction(() => {
      const version = (this.latestSettings(repoId)?.version ?? 0) + 1;
      const id = this.#insert(
        "INSERT INTO settings_versions (repo_id, version, saved_at, saved_by, settings) VALUES (?, ?, ?, ?, ?)",
        repoId,
        version,
        this.#time(),
        savedBy,
        JSON.stringify(settings),
      );
      return mapOrNull(this.#get("SELECT * FROM settings_versions WHERE id = ?", id), toSettings)!;
    });
  }

  settingsVersion(repoId: number, version: number): SettingsVersionRecord | null {
    return mapOrNull(
      this.#get("SELECT * FROM settings_versions WHERE repo_id = ? AND version = ?", repoId, version),
      toSettings,
    );
  }

  /** Every saved version of a repo's settings, newest first. */
  settingsHistory(repoId: number): SettingsVersionRecord[] {
    return this.#all("SELECT * FROM settings_versions WHERE repo_id = ? ORDER BY version DESC", repoId).map(toSettings);
  }

  latestSettings(repoId: number): SettingsVersionRecord | null {
    return mapOrNull(
      this.#get("SELECT * FROM settings_versions WHERE repo_id = ? ORDER BY version DESC LIMIT 1", repoId),
      toSettings,
    );
  }

  /**
   * Saves a new version of the global settings. A save is not a call
   * (ADR-0018), and older versions stay readable.
   */
  saveGlobalSettings(settings: object, savedBy: string): GlobalSettingsVersionRecord {
    return this.transaction(() => {
      const version = (this.latestGlobalSettings()?.version ?? 0) + 1;
      this.#insert(
        "INSERT INTO global_settings_versions (version, saved_at, saved_by, settings) VALUES (?, ?, ?, ?)",
        version,
        this.#time(),
        savedBy,
        JSON.stringify(settings),
      );
      return this.globalSettingsVersion(version)!;
    });
  }

  latestGlobalSettings(): GlobalSettingsVersionRecord | null {
    return mapOrNull(this.#get("SELECT * FROM global_settings_versions ORDER BY version DESC LIMIT 1"), toGlobalSettings);
  }

  globalSettingsVersion(version: number): GlobalSettingsVersionRecord | null {
    return mapOrNull(this.#get("SELECT * FROM global_settings_versions WHERE version = ?", version), toGlobalSettings);
  }

  /** Every saved version of the global settings, newest first. */
  globalSettingsHistory(): GlobalSettingsVersionRecord[] {
    return this.#all("SELECT * FROM global_settings_versions ORDER BY version DESC").map(toGlobalSettings);
  }

  // Tickets

  /** Takes an issue into intake as a new ticket, which starts deciding. */
  takeIn(ticket: NewTicket): TicketRecord {
    const id = this.#insert(
      "INSERT INTO tickets (repo_id, issue_number, predecessor_id, taken_in_at) VALUES (?, ?, ?, ?)",
      ticket.repoId,
      ticket.issueNumber,
      ticket.predecessorId ?? null,
      this.#time(),
    );
    return this.getTicket(id)!;
  }

  getTicket(id: number): TicketRecord | null {
    return mapOrNull(this.#get(`${TICKET_SELECT} WHERE t.id = ?`, id), toTicket);
  }

  /** A repo's tickets that are not final, oldest first. */
  ticketsInFlight(repoId: number): TicketRecord[] {
    return this.#all(`${TICKET_SELECT} WHERE t.repo_id = ? AND s.state NOT IN (${FINAL_STATE_LIST}) ORDER BY t.id`, repoId).map(toTicket);
  }

  /** The ticket that pulled the same issue in again after this one ended, if any (ADR-0020). */
  successorOf(ticketId: number): TicketRecord | null {
    return mapOrNull(this.#get(`${TICKET_SELECT} WHERE t.predecessor_id = ? ORDER BY t.id LIMIT 1`, ticketId), toTicket);
  }

  /** The issue's newest ticket, in flight or final. */
  latestTicketForIssue(repoId: number, issueNumber: number): TicketRecord | null {
    return mapOrNull(
      this.#get(`${TICKET_SELECT} WHERE t.repo_id = ? AND t.issue_number = ? ORDER BY t.id DESC LIMIT 1`, repoId, issueNumber),
      toTicket,
    );
  }

  // Calls

  /**
   * Records a call with every model run behind it, in one transaction. A call
   * with `stateTo` moves its ticket there; the store refuses a state change
   * spec §17 does not allow.
   */
  recordCall(call: NewCall): CallRecord {
    return this.transaction(() => {
      let stateFrom: TicketState | null = null;
      if (call.stateTo !== undefined) {
        const ticket = this.getTicket(call.ticketId);
        if (!ticket) throw new Error(`no ticket ${call.ticketId}`);
        assertTransition(ticket.state, call.stateTo);
        stateFrom = ticket.state;
      }
      const inputs = call.inputs ?? null;
      const id = this.#insert(
        `INSERT INTO calls (ticket_id, made_at, kind, reason, citation, answer_id, no_contradiction_found, checks, challenge,
           issue_title, issue_body, vision_sha, pins, settings_version_id, pr_head_sha, detail, state_from, state_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        call.ticketId,
        this.#time(),
        call.kind,
        call.reason,
        json(call.citation),
        call.answerId ?? null,
        call.noContradictionFound ? 1 : 0,
        json(call.checks),
        json(call.challenge),
        inputs?.issueTitle ?? null,
        inputs?.issueBody ?? null,
        inputs?.visionSha ?? null,
        json(inputs?.pins),
        inputs?.settingsVersionId ?? null,
        inputs?.prHeadSha ?? null,
        json(call.detail),
        stateFrom,
        call.stateTo ?? null,
      );
      for (const run of call.modelRuns ?? []) {
        this.#insert(
          `INSERT INTO model_runs (call_id, purpose, model, prompt_version, session_id, input, output, started_at, duration_ms, estimated_cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          run.purpose,
          run.model,
          run.promptVersion,
          run.sessionId ?? null,
          run.input,
          run.output,
          run.startedAt,
          run.durationMs,
          run.estimatedCostUsd,
        );
      }
      return this.getCall(id)!;
    });
  }

  /** A call with its model runs and the comments it posted. */
  getCall(id: number): CallRecord | null {
    const row = this.#get("SELECT c.*, t.repo_id FROM calls c JOIN tickets t ON t.id = c.ticket_id WHERE c.id = ?", id);
    return row ? this.#toCall(row) : null;
  }

  /** A ticket's calls, oldest first. */
  callsForTicket(ticketId: number): CallRecord[] {
    return this.#all(
      "SELECT c.*, t.repo_id FROM calls c JOIN tickets t ON t.id = c.ticket_id WHERE c.ticket_id = ? ORDER BY c.id",
      ticketId,
    ).map((row) => this.#toCall(row));
  }

  /** Every call the filter keeps, across all repos, newest first. */
  listCalls(filter: CallFilter = {}): CallRecord[] {
    const where = callWhere(filter);
    return this.#all(
      `SELECT c.*, t.repo_id FROM calls c JOIN tickets t ON t.id = c.ticket_id WHERE ${where.sql} ORDER BY c.id DESC`,
      ...where.params,
    ).map((row) => this.#toCall(row));
  }

  /** The days with calls the filter keeps, newest first, with how many calls each. */
  callDays(filter: CallFilter = {}): { day: string; calls: number }[] {
    const where = callWhere(filter);
    return this.#all(
      `SELECT substr(c.made_at, 1, 10) AS day, count(*) AS n FROM calls c JOIN tickets t ON t.id = c.ticket_id
       WHERE ${where.sql} GROUP BY day ORDER BY day DESC`,
      ...where.params,
    ).map((row) => ({ day: str(row.day), calls: num(row.n) }));
  }

  /** One model run behind a call, with its full input and output. */
  getModelRun(id: number): ModelRunRecord | null {
    return mapOrNull(this.#get("SELECT * FROM model_runs WHERE id = ?", id), toModelRun);
  }

  // The board

  raiseBoardItem(item: NewBoardItem): BoardItemRecord {
    const id = this.#insert(
      "INSERT INTO board_items (ticket_id, call_id, raised_at, decision, why_raised, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
      item.ticketId,
      item.callId,
      this.#time(),
      item.decision,
      item.whyRaised,
      JSON.stringify(item.snapshot),
    );
    return mapOrNull(this.#get("SELECT * FROM board_items WHERE id = ?", id), toBoardItem)!;
  }

  /** Records the owner's answer. An answer is not a call; the change it causes is a call citing it. */
  recordAnswer(answer: NewAnswer): AnswerRecord {
    const id = this.#insert(
      `INSERT INTO answers (board_item_id, answered_at, answered_by, shape, option_id, text, note, show_note_on_issue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      answer.boardItemId,
      this.#time(),
      answer.answeredBy,
      answer.shape,
      answer.optionId ?? null,
      answer.text ?? null,
      answer.note ?? null,
      answer.showNoteOnIssue ? 1 : 0,
    );
    return mapOrNull(this.#get("SELECT * FROM answers WHERE id = ?", id), toAnswer)!;
  }

  withdrawBoardItem(withdrawal: NewWithdrawal): void {
    this.#insert(
      "INSERT INTO board_item_withdrawals (board_item_id, call_id, withdrawn_at, reason) VALUES (?, ?, ?, ?)",
      withdrawal.boardItemId,
      withdrawal.callId,
      this.#time(),
      withdrawal.reason,
    );
  }

  /** Every board item raised for a ticket, oldest first. */
  boardItemsForTicket(ticketId: number): BoardItemRecord[] {
    return this.#all("SELECT * FROM board_items WHERE ticket_id = ? ORDER BY id", ticketId).map(toBoardItem);
  }

  /** The answer given to a board item, or null while it has none. */
  answerFor(boardItemId: number): AnswerRecord | null {
    return mapOrNull(this.#get("SELECT * FROM answers WHERE board_item_id = ?", boardItemId), toAnswer);
  }

  /** The ticket's open board item: neither answered nor withdrawn. */
  openBoardItem(ticketId: number): BoardItemRecord | null {
    return mapOrNull(
      this.#get(
        `SELECT b.* FROM board_items b WHERE b.ticket_id = ?
           AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.board_item_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM board_item_withdrawals w WHERE w.board_item_id = b.id)`,
        ticketId,
      ),
      toBoardItem,
    );
  }

  /** Every board item raised for a ticket, oldest first, each with its answer or withdrawal. */
  boardItemsForTicket(ticketId: number): BoardItemHistory[] {
    return this.#all("SELECT * FROM board_items WHERE ticket_id = ? ORDER BY id", ticketId).map((row) => {
      const item = toBoardItem(row);
      return {
        item,
        answer: mapOrNull(this.#get("SELECT * FROM answers WHERE board_item_id = ?", item.id), toAnswer),
        withdrawal: mapOrNull(this.#get("SELECT * FROM board_item_withdrawals WHERE board_item_id = ?", item.id), toWithdrawal),
      };
    });
  }

  // The vision of record

  recordVisionLineOrigin(origin: NewVisionLineOrigin): VisionLineOriginRecord {
    const id = this.#insert(
      "INSERT INTO vision_line_origins (repo_id, line, origin, commit_sha, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
      origin.repoId,
      origin.line,
      origin.origin,
      origin.commitSha,
      origin.source,
      this.#time(),
    );
    return mapOrNull(this.#get("SELECT * FROM vision_line_origins WHERE id = ?", id), toOrigin)!;
  }

  /** A line's current origin: the latest recorded for its exact text. */
  visionLineOrigin(repoId: number, line: string): VisionLineOriginRecord | null {
    return mapOrNull(
      this.#get("SELECT * FROM vision_line_origins WHERE repo_id = ? AND line = ? ORDER BY id DESC LIMIT 1", repoId, line),
      toOrigin,
    );
  }

  recordVisionChange(change: NewVisionChange): VisionChangeRecord {
    const id = this.#insert(
      "INSERT INTO vision_changes (repo_id, commit_sha, blob_sha, previous_blob_sha, removed, added, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      change.repoId,
      change.commitSha,
      change.blobSha,
      change.previousBlobSha,
      JSON.stringify(change.removed),
      JSON.stringify(change.added),
      this.#time(),
    );
    return mapOrNull(this.#get("SELECT * FROM vision_changes WHERE id = ?", id), toVisionChange)!;
  }

  // Forge writes

  /** Records a forge write before it is sent (ADR-0017). */
  recordForgeWriteIntent(intent: NewForgeWriteIntent): ForgeWriteIntentRecord {
    const id = this.#insert(
      "INSERT INTO forge_write_intents (repo_id, ticket_id, call_id, kind, target, number, payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      intent.repoId,
      intent.ticketId ?? null,
      intent.callId ?? null,
      intent.kind,
      intent.target,
      intent.number,
      JSON.stringify(intent.payload),
      this.#time(),
    );
    return mapOrNull(this.#get("SELECT * FROM forge_write_intents WHERE id = ?", id), toIntent)!;
  }

  /** Confirms a forge write once it was sent, or settled by reading the forge on start. */
  confirmForgeWrite(confirmation: ForgeWriteConfirmation): void {
    this.#insert(
      "INSERT INTO forge_write_confirmations (intent_id, confirmed_at, comment_id, comment_url, result) VALUES (?, ?, ?, ?, ?)",
      confirmation.intentId,
      this.#time(),
      confirmation.comment?.id ?? null,
      confirmation.comment?.url ?? null,
      json(confirmation.result),
    );
  }

  /** The forge writes a call recorded, confirmed or not, oldest first. */
  forgeWritesForCall(callId: number): ForgeWriteIntentRecord[] {
    return this.#all("SELECT * FROM forge_write_intents WHERE call_id = ? ORDER BY id", callId).map(toIntent);
  }

  /** Forge writes recorded but never confirmed, oldest first, to settle on start. */
  unconfirmedForgeWrites(): ForgeWriteIntentRecord[] {
    return this.#all(
      `SELECT i.* FROM forge_write_intents i
       WHERE NOT EXISTS (SELECT 1 FROM forge_write_confirmations c WHERE c.intent_id = i.id) ORDER BY i.id`,
    ).map(toIntent);
  }

  /** The forge ids of the comments already confirmed for a repo's issue or PR, so settling never claims one twice. */
  confirmedCommentIds(repoId: number, target: "issue" | "pr", number: number): string[] {
    return this.#all(
      `SELECT c.comment_id FROM forge_write_intents i JOIN forge_write_confirmations c ON c.intent_id = i.id
       WHERE i.repo_id = ? AND i.target = ? AND i.number = ? AND c.comment_id IS NOT NULL ORDER BY i.id`,
      repoId,
      target,
      number,
    ).map((r) => str(r.comment_id));
  }

  // Internals

  #time(): string {
    return this.#now().toISOString();
  }

  #insert(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#db.prepare(sql).run(...params).lastInsertRowid);
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params);
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#db.prepare(sql).all(...params);
  }

  #toCall(row: Row): CallRecord {
    const id = num(row.id);
    const inputs: JudgedInputs = {
      issueTitle: strOrNull(row.issue_title),
      issueBody: strOrNull(row.issue_body),
      visionSha: strOrNull(row.vision_sha),
      pins: parse(row.pins),
      settingsVersionId: numOrNull(row.settings_version_id),
      prHeadSha: strOrNull(row.pr_head_sha),
    };
    const stateFrom = strOrNull(row.state_from) as TicketState | null;
    return {
      id,
      ticketId: num(row.ticket_id),
      repoId: num(row.repo_id),
      madeAt: str(row.made_at),
      kind: str(row.kind) as CallKind,
      reason: str(row.reason),
      citation: parse(row.citation) as Citation | null,
      answerId: numOrNull(row.answer_id),
      noContradictionFound: row.no_contradiction_found === 1,
      checks: parse(row.checks),
      challenge: parse(row.challenge),
      inputs: Object.values(inputs).every((v) => v === null) ? null : inputs,
      detail: parse(row.detail),
      stateChange: stateFrom === null ? null : { from: stateFrom, to: str(row.state_to) as TicketState },
      modelRuns: this.#all("SELECT * FROM model_runs WHERE call_id = ? ORDER BY id", id).map(toModelRun),
      postedComments: this.#all(
        `SELECT c.intent_id, c.comment_id, c.comment_url, c.confirmed_at
         FROM forge_write_intents i JOIN forge_write_confirmations c ON c.intent_id = i.id
         WHERE i.call_id = ? AND i.kind = 'comment' ORDER BY i.id`,
        id,
      ).map((r) => ({
        intentId: num(r.intent_id),
        commentId: str(r.comment_id),
        commentUrl: str(r.comment_url),
        confirmedAt: str(r.confirmed_at),
      })),
    };
  }
}

/** The WHERE clause for a {@link CallFilter}, over `calls c JOIN tickets t`. */
function callWhere(filter: CallFilter): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (sql: string, value: SQLInputValue | undefined) => {
    if (value === undefined) return;
    parts.push(sql);
    params.push(value);
  };
  add("t.repo_id = ?", filter.repoId);
  add("c.ticket_id = ?", filter.ticketId);
  add("c.kind = ?", filter.kind);
  add("substr(c.made_at, 1, 10) >= ?", filter.fromDay);
  add("substr(c.made_at, 1, 10) <= ?", filter.toDay);
  return { sql: parts.length === 0 ? "1" : parts.join(" AND "), params };
}

const FINAL_STATE_LIST = FINAL_STATES.map((state) => `'${state}'`).join(", ");

const TICKET_SELECT = `SELECT t.*, s.state, s.call_id AS state_call_id, s.changed_at AS state_changed_at
  FROM tickets t JOIN ticket_states s ON s.ticket_id = t.id`;

/** Creates the schema in a new store, and refuses one it cannot read. */
function migrate(db: DatabaseSync, path: string): void {
  const version = num(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new StoreOpenError(path, `it was written by a newer entail (schema ${version}, this entail reads ${SCHEMA_VERSION})`);
  }
  if (version === 0) {
    const tables = num(db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n ?? 0);
    if (tables > 0) throw new StoreOpenError(path, "it is not an entail store");
    inTransaction(db, () => {
      db.exec(SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    return;
  }
  // An older store is brought up to date one version at a time.
  for (let from = version; from < SCHEMA_VERSION; from++) {
    const step = MIGRATIONS[from];
    if (step === undefined) throw new StoreOpenError(path, `no migration from schema ${from}`);
    inTransaction(db, () => {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${from + 1}`);
    });
  }
}

function inTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parse(value: SQLOutputValue | undefined): unknown {
  return typeof value === "string" ? JSON.parse(value) : null;
}

function num(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function numOrNull(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: SQLOutputValue | undefined): string {
  return String(value);
}

function strOrNull(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapOrNull<T>(row: Row | undefined, map: (row: Row) => T): T | null {
  return row ? map(row) : null;
}

function toRepo(row: Row): RepoRecord {
  return {
    id: num(row.id),
    forge: str(row.forge) as Forge,
    host: str(row.host),
    projectId: num(row.project_id),
    path: str(row.path),
    ownerAccountId: num(row.owner_account_id),
    ownerLogin: str(row.owner_login),
    enrolledAt: str(row.enrolled_at),
  };
}

function toSettings(row: Row): SettingsVersionRecord {
  return {
    id: num(row.id),
    repoId: num(row.repo_id),
    version: num(row.version),
    savedAt: str(row.saved_at),
    savedBy: str(row.saved_by),
    settings: parse(row.settings),
  };
}

function toEnrollment(row: Row): EnrollmentRecord {
  return {
    id: num(row.id),
    repoId: num(row.repo_id),
    enrolledAt: str(row.enrolled_at),
    visionSha: str(row.vision_sha),
    settingsVersionId: num(row.settings_version_id),
    openIssueNumbers: parse(row.open_issue_numbers) as number[],
  };
}

function toEnrollmentModelRun(row: Row): EnrollmentModelRunRecord {
  return {
    id: num(row.id),
    enrollmentId: num(row.enrollment_id),
    purpose: str(row.purpose),
    model: str(row.model),
    promptVersion: str(row.prompt_version),
    sessionId: strOrNull(row.session_id),
    input: str(row.input),
    output: strOrNull(row.output),
    failure: parse(row.failure),
    startedAt: str(row.started_at),
    durationMs: num(row.duration_ms),
    estimatedCostUsd: numOrNull(row.estimated_cost_usd),
  };
}

function toGlobalSettings(row: Row): GlobalSettingsVersionRecord {
  return {
    id: num(row.id),
    version: num(row.version),
    savedAt: str(row.saved_at),
    savedBy: str(row.saved_by),
    settings: parse(row.settings),
  };
}

function toTicket(row: Row): TicketRecord {
  return {
    id: num(row.id),
    repoId: num(row.repo_id),
    issueNumber: num(row.issue_number),
    predecessorId: numOrNull(row.predecessor_id),
    takenInAt: str(row.taken_in_at),
    state: str(row.state) as TicketState,
    stateCallId: numOrNull(row.state_call_id),
    stateChangedAt: str(row.state_changed_at),
  };
}

function toModelRun(row: Row): ModelRunRecord {
  return {
    id: num(row.id),
    callId: num(row.call_id),
    purpose: str(row.purpose),
    model: str(row.model),
    promptVersion: str(row.prompt_version),
    sessionId: strOrNull(row.session_id),
    input: str(row.input),
    output: str(row.output),
    startedAt: str(row.started_at),
    durationMs: num(row.duration_ms),
    estimatedCostUsd: num(row.estimated_cost_usd),
  };
}

function toBoardItem(row: Row): BoardItemRecord {
  return {
    id: num(row.id),
    ticketId: num(row.ticket_id),
    callId: num(row.call_id),
    raisedAt: str(row.raised_at),
    decision: str(row.decision),
    whyRaised: str(row.why_raised),
    snapshot: parse(row.snapshot),
  };
}

function toAnswer(row: Row): AnswerRecord {
  return {
    id: num(row.id),
    boardItemId: num(row.board_item_id),
    answeredAt: str(row.answered_at),
    answeredBy: str(row.answered_by),
    shape: str(row.shape) as AnswerShape,
    optionId: strOrNull(row.option_id),
    text: strOrNull(row.text),
    note: strOrNull(row.note),
    showNoteOnIssue: row.show_note_on_issue === 1,
  };
}

function toWithdrawal(row: Row): WithdrawalRecord {
  return {
    boardItemId: num(row.board_item_id),
    callId: num(row.call_id),
    withdrawnAt: str(row.withdrawn_at),
    reason: str(row.reason),
  };
}

function toOrigin(row: Row): VisionLineOriginRecord {
  return {
    id: num(row.id),
    repoId: num(row.repo_id),
    line: str(row.line),
    origin: str(row.origin) as VisionOrigin,
    commitSha: str(row.commit_sha),
    source: str(row.source) as VisionLineOriginRecord["source"],
    recordedAt: str(row.recorded_at),
  };
}

function toVisionChange(row: Row): VisionChangeRecord {
  return {
    id: num(row.id),
    repoId: num(row.repo_id),
    commitSha: str(row.commit_sha),
    blobSha: str(row.blob_sha),
    previousBlobSha: strOrNull(row.previous_blob_sha),
    removed: parse(row.removed) as string[],
    added: parse(row.added) as string[],
    seenAt: str(row.seen_at),
  };
}

function toIntent(row: Row): ForgeWriteIntentRecord {
  return {
    id: num(row.id),
    repoId: num(row.repo_id),
    ticketId: numOrNull(row.ticket_id),
    callId: numOrNull(row.call_id),
    kind: str(row.kind) as ForgeWriteKind,
    target: str(row.target) as "issue" | "pr",
    number: num(row.number),
    payload: parse(row.payload),
    recordedAt: str(row.recorded_at),
  };
}
