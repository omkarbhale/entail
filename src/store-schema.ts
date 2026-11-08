import { FINAL_STATES, INITIAL_STATE, TICKET_STATES, TICKET_TRANSITIONS } from "./ticket-states.ts";

/** Bumped whenever the schema below changes; a store from a newer entail is refused. */
export const SCHEMA_VERSION = 9;

/**
 * Every table of the store except `ticket_states`. The store itself refuses
 * an UPDATE or DELETE on any of them (ADR-0009).
 */
export const APPEND_ONLY_TABLES = [
  "repos",
  "settings_versions",
  "global_settings_versions",
  "tickets",
  "calls",
  "model_runs",
  "board_items",
  "board_item_withdrawals",
  "answers",
  "vision_line_origins",
  "vision_changes",
  "enrollments",
  "enrollment_model_runs",
  "unenrollments",
  "forge_write_intents",
  "forge_write_confirmations",
  "fresh_starts",
] as const;

export const VISION_ORIGINS = [
  "owner-stated",
  "agent-proposed-owner-approved",
  "automatic-owner-notified",
] as const;

export const ANSWER_SHAPES = ["option", "own-words", "dont-go-ahead"] as const;

export const FORGE_WRITE_KINDS = ["comment", "label", "close", "merge"] as const;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
const json = (column: string) => `CHECK (${column} IS NULL OR json_valid(${column}))`;
const jsonArray = (column: string) => `CHECK (json_valid(${column}) AND json_type(${column}) = 'array')`;

const STATES = list(TICKET_STATES);
const FINALS = list(FINAL_STATES);
const TRANSITIONS = Object.entries(TICKET_TRANSITIONS)
  .flatMap(([from, tos]) => tos.map((to) => `('${from}', '${to}')`))
  .join(", ");

/** Holds every ticket state change to spec §17's transitions, as {@link TICKET_TRANSITIONS} lists them. */
const TRANSITION_TRIGGER = `CREATE TRIGGER ticket_states_transition BEFORE UPDATE ON ticket_states
WHEN (OLD.state, NEW.state) NOT IN (VALUES ${TRANSITIONS})
BEGIN SELECT RAISE(ABORT, 'spec §17 does not allow this ticket state change'); END;
`;

/**
 * Each table's primary and unique keys. An insert that would replace a row
 * on any of them is refused, so INSERT OR REPLACE cannot delete a record even
 * on a connection without recursive triggers.
 */
const KEYS: Readonly<Record<(typeof APPEND_ONLY_TABLES)[number] | "ticket_states", readonly (readonly string[])[]>> = {
  repos: [["id"], ["forge", "host", "project_id"]],
  settings_versions: [["id"], ["repo_id", "version"]],
  global_settings_versions: [["id"], ["version"]],
  tickets: [["id"]],
  ticket_states: [["ticket_id"]],
  calls: [["id"]],
  model_runs: [["id"]],
  board_items: [["id"]],
  board_item_withdrawals: [["board_item_id"]],
  answers: [["id"], ["board_item_id"]],
  vision_line_origins: [["id"]],
  vision_changes: [["id"]],
  enrollments: [["id"]],
  enrollment_model_runs: [["id"]],
  unenrollments: [["id"]],
  forge_write_intents: [["id"]],
  forge_write_confirmations: [["intent_id"]],
  fresh_starts: [["id"]],
};

const noReplace = ([table, keys]: [string, readonly (readonly string[])[]]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN ${keys
  .map((key) => `EXISTS (SELECT 1 FROM ${table} WHERE ${key.map((c) => `${c} = NEW.${c}`).join(" AND ")})`)
  .join("\n  OR ")}
BEGIN SELECT RAISE(ABORT, 'the store is append-only: a ${table} row cannot be replaced'); END;
`;

const appendOnly = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'the store is append-only: ${table} rows cannot be updated'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'the store is append-only: ${table} rows cannot be deleted'); END;
`;

// Every save of the global settings is a new version (spec §15, ADR-0018).
const GLOBAL_SETTINGS_TABLE = `
CREATE TABLE global_settings_versions (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK (version > 0),
  saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL CHECK (saved_by <> ''),
  settings TEXT NOT NULL CHECK (json_valid(settings) AND json_type(settings) = 'object')
) STRICT;
`;

const GLOBAL_SETTINGS_IN_ORDER = `
-- Global settings versions count up from 1.
CREATE TRIGGER global_settings_versions_in_order BEFORE INSERT ON global_settings_versions
WHEN NEW.version <> coalesce((SELECT max(version) FROM global_settings_versions), 0) + 1
BEGIN SELECT RAISE(ABORT, 'a global settings version must follow the latest version'); END;
`;

// What enrolling a repo recorded beside the repo, its first settings version
// and its vision line origins: the VISION.md commit the owner reviewed, and
// the issues already open, which are not taken in (ADR-0018).
const ENROLLMENTS_TABLE = `
CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  enrolled_at TEXT NOT NULL,
  vision_sha TEXT NOT NULL CHECK (vision_sha <> ''),
  settings_version_id INTEGER NOT NULL REFERENCES settings_versions(id),
  open_issue_numbers TEXT NOT NULL ${jsonArray("open_issue_numbers")}
) STRICT;
CREATE INDEX enrollments_by_repo ON enrollments (repo_id, id);
`;

// The model runs enrolling made, which belong to no ticket and so to no
// call: the generic criteria proposal (spec §15 step 4). A run that failed
// keeps its failure in place of an output.
const ENROLLMENT_MODEL_RUNS_TABLE = `
CREATE TABLE enrollment_model_runs (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  purpose TEXT NOT NULL CHECK (purpose <> ''),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  session_id TEXT,
  input TEXT NOT NULL,
  output TEXT,
  failure TEXT ${json("failure")},
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  estimated_cost_usd REAL CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  CHECK ((output IS NULL) <> (failure IS NULL))
) STRICT;
CREATE INDEX enrollment_model_runs_by_enrollment ON enrollment_model_runs (enrollment_id, id);
`;

// The owner confirmed a fresh start for a repo whose issues carried entail's
// hidden marker with no records behind it: those issues are left alone, and
// only new ones are taken in (ADR-0009). Like a settings save, it is not a call.
const FRESH_STARTS_TABLE = `
CREATE TABLE fresh_starts (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT NOT NULL CHECK (confirmed_by <> ''),
  marked_issue_numbers TEXT NOT NULL ${jsonArray("marked_issue_numbers")}
) STRICT;
CREATE INDEX fresh_starts_by_repo ON fresh_starts (repo_id, id);
`;

// An unenrolled repo: the enrollment the owner ended, or none for a repo
// enrolled before enrollments were recorded. Its records stay, read-only;
// enrolling it again records a new enrollment, which this row does not end
// (ADR-0018).
const UNENROLLMENTS_TABLE = `
CREATE TABLE unenrollments (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  enrollment_id INTEGER REFERENCES enrollments(id),
  unenrolled_at TEXT NOT NULL,
  unenrolled_by TEXT NOT NULL CHECK (unenrolled_by <> '')
) STRICT;
CREATE INDEX unenrollments_by_repo ON unenrollments (repo_id, id);
`;

const UNENROLLMENTS_OF_LATEST = `
-- An unenrollment ends the repo's latest enrollment, once.
CREATE TRIGGER unenrollments_of_latest BEFORE INSERT ON unenrollments
WHEN NEW.enrollment_id IS NOT (SELECT max(id) FROM enrollments WHERE repo_id = NEW.repo_id)
  OR EXISTS (SELECT 1 FROM unenrollments WHERE repo_id = NEW.repo_id AND enrollment_id IS NEW.enrollment_id)
BEGIN SELECT RAISE(ABORT, 'an unenrollment ends the repo''s latest enrollment, once'); END;
`;

const ENROLLMENTS_SETTINGS_OF_REPO = `
-- An enrollment's settings version is its own repo's.
CREATE TRIGGER enrollments_settings_of_repo BEFORE INSERT ON enrollments
WHEN (SELECT repo_id FROM settings_versions WHERE id = NEW.settings_version_id) IS NOT NEW.repo_id
BEGIN SELECT RAISE(ABORT, 'an enrollment''s settings version must be its repo''s'); END;
`;

/**
 * The store's schema. Integrity rules the rest of MVP-1 relies on are kept
 * by the store itself, in triggers, rather than by the code that writes it:
 *
 * - Every table but `ticket_states` refuses updates and deletes.
 * - `ticket_states` holds each ticket's current state, the one row that
 *   changes. It changes only when a call recording that state change is
 *   inserted: the call's insert updates it in the same statement, and any
 *   other update or delete is refused. Transitions follow spec §17, so a
 *   final state cannot be left.
 * - An issue has at most one ticket in flight, and a ticket pulled in again
 *   links to the issue's latest ticket as its predecessor (ADR-0020).
 * - A board item is raised by the call that put its ticket on the board, a
 *   ticket has at most one open item, and an item is either answered or
 *   withdrawn, never both (ADR-0008).
 */
export const SCHEMA_SQL = `
-- An enrolled repo, keyed on its forge, host and numeric project id, so a
-- renamed or transferred repo keeps its records (ADR-0015, ADR-0018).
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  forge TEXT NOT NULL CHECK (forge IN ('github', 'gitlab')),
  host TEXT NOT NULL CHECK (host <> ''),
  project_id INTEGER NOT NULL CHECK (project_id > 0),
  path TEXT NOT NULL CHECK (path <> ''),
  owner_account_id INTEGER NOT NULL,
  owner_login TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  UNIQUE (forge, host, project_id)
) STRICT;

-- Every save of a repo's settings is a new version (ADR-0018).
CREATE TABLE settings_versions (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  version INTEGER NOT NULL CHECK (version > 0),
  saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  settings TEXT NOT NULL CHECK (json_valid(settings)),
  UNIQUE (repo_id, version)
) STRICT;

${GLOBAL_SETTINGS_TABLE}
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  predecessor_id INTEGER REFERENCES tickets(id),
  taken_in_at TEXT NOT NULL
) STRICT;
CREATE INDEX tickets_by_issue ON tickets (repo_id, issue_number);

-- The one row per ticket that changes.
CREATE TABLE ticket_states (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  state TEXT NOT NULL CHECK (state IN (${STATES})),
  call_id INTEGER REFERENCES calls(id),
  changed_at TEXT NOT NULL
) STRICT;

CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  made_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind <> ''),
  reason TEXT NOT NULL CHECK (reason <> ''),
  citation TEXT ${json("citation")},
  answer_id INTEGER REFERENCES answers(id),
  no_contradiction_found INTEGER NOT NULL DEFAULT 0 CHECK (no_contradiction_found IN (0, 1)),
  checks TEXT ${json("checks")},
  challenge TEXT ${json("challenge")},
  issue_title TEXT,
  issue_body TEXT,
  vision_sha TEXT,
  pins TEXT ${json("pins")},
  settings_version_id INTEGER REFERENCES settings_versions(id),
  pr_head_sha TEXT,
  detail TEXT ${json("detail")},
  state_from TEXT CHECK (state_from IS NULL OR state_from IN (${STATES})),
  state_to TEXT CHECK (state_to IS NULL OR state_to IN (${STATES})),
  CHECK ((state_from IS NULL) = (state_to IS NULL)),
  CHECK (no_contradiction_found = 0 OR (citation IS NULL AND answer_id IS NULL))
) STRICT;
CREATE INDEX calls_by_ticket ON calls (ticket_id, id);

CREATE TABLE model_runs (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  purpose TEXT NOT NULL CHECK (purpose <> ''),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  session_id TEXT,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0)
) STRICT;
CREATE INDEX model_runs_by_call ON model_runs (call_id, id);

CREATE TABLE board_items (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  call_id INTEGER NOT NULL REFERENCES calls(id),
  raised_at TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision <> ''),
  why_raised TEXT NOT NULL CHECK (why_raised <> ''),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
CREATE INDEX board_items_by_ticket ON board_items (ticket_id);

CREATE TABLE board_item_withdrawals (
  board_item_id INTEGER PRIMARY KEY REFERENCES board_items(id),
  call_id INTEGER NOT NULL REFERENCES calls(id),
  withdrawn_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason <> '')
) STRICT;

-- An answer is final, one per board item, and not a call (ADR-0008). It
-- records the item version the board form showed (ADR-0012).
CREATE TABLE answers (
  id INTEGER PRIMARY KEY,
  board_item_id INTEGER NOT NULL UNIQUE REFERENCES board_items(id),
  answered_at TEXT NOT NULL,
  answered_by TEXT NOT NULL CHECK (answered_by <> ''),
  item_version INTEGER NOT NULL DEFAULT 1 CHECK (item_version > 0),
  shape TEXT NOT NULL CHECK (shape IN (${list(ANSWER_SHAPES)})),
  option_id TEXT,
  text TEXT,
  note TEXT,
  show_note_on_issue INTEGER NOT NULL DEFAULT 0 CHECK (show_note_on_issue IN (0, 1)),
  CHECK ((shape = 'option') = (option_id IS NOT NULL)),
  CHECK ((shape = 'own-words') = (text IS NOT NULL)),
  CHECK (note IS NOT NULL OR show_note_on_issue = 0)
) STRICT;

-- A vision line's origin; the latest row for a line is its current origin (ADR-0004).
CREATE TABLE vision_line_origins (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  line TEXT NOT NULL CHECK (line <> ''),
  origin TEXT NOT NULL CHECK (origin IN (${list(VISION_ORIGINS)})),
  commit_sha TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('trailer', 'no-trailer', 'enrollment')),
  recorded_at TEXT NOT NULL,
  -- The commit's \`Vision-Origin\` trailer values as written, kept whatever the origin (ADR-0004).
  raw_trailer TEXT
) STRICT;
CREATE INDEX vision_line_origins_by_line ON vision_line_origins (repo_id, line);

-- A new VISION.md blob on the default branch, as the lines it removed and added (ADR-0016).
CREATE TABLE vision_changes (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  commit_sha TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  previous_blob_sha TEXT,
  removed TEXT NOT NULL ${jsonArray("removed")},
  added TEXT NOT NULL ${jsonArray("added")},
  seen_at TEXT NOT NULL
) STRICT;

${ENROLLMENTS_TABLE}
${ENROLLMENT_MODEL_RUNS_TABLE}
${FRESH_STARTS_TABLE}
${UNENROLLMENTS_TABLE}
-- A forge write recorded before it is sent; confirmed by a row in
-- forge_write_confirmations once sent or settled on start (ADR-0017).
CREATE TABLE forge_write_intents (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  ticket_id INTEGER REFERENCES tickets(id),
  call_id INTEGER REFERENCES calls(id),
  kind TEXT NOT NULL CHECK (kind IN (${list(FORGE_WRITE_KINDS)})),
  target TEXT NOT NULL CHECK (target IN ('issue', 'pr')),
  number INTEGER NOT NULL CHECK (number > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX forge_write_intents_by_call ON forge_write_intents (call_id);

CREATE TABLE forge_write_confirmations (
  intent_id INTEGER PRIMARY KEY REFERENCES forge_write_intents(id),
  confirmed_at TEXT NOT NULL,
  comment_id TEXT,
  comment_url TEXT,
  result TEXT ${json("result")},
  CHECK ((comment_id IS NULL) = (comment_url IS NULL))
) STRICT;

${APPEND_ONLY_TABLES.map(appendOnly).join("")}

-- Settings versions count up from 1 per repo.
CREATE TRIGGER settings_versions_in_order BEFORE INSERT ON settings_versions
WHEN NEW.version <> coalesce((SELECT max(version) FROM settings_versions WHERE repo_id = NEW.repo_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'a settings version must follow the repo''s latest version'); END;

${GLOBAL_SETTINGS_IN_ORDER}
${ENROLLMENTS_SETTINGS_OF_REPO}
${UNENROLLMENTS_OF_LATEST}
-- An issue has at most one ticket in flight; a ticket pulled in again links
-- to the issue's latest ticket, and a first ticket links to none (ADR-0020).
CREATE TRIGGER tickets_link_predecessor BEFORE INSERT ON tickets
WHEN NEW.predecessor_id IS NOT (
  SELECT max(id) FROM tickets WHERE repo_id = NEW.repo_id AND issue_number = NEW.issue_number
)
BEGIN SELECT RAISE(ABORT, 'a ticket pulled in again must link to the issue''s latest ticket as its predecessor'); END;
-- Created last so it is checked first, for the clearer refusal.
CREATE TRIGGER tickets_one_in_flight BEFORE INSERT ON tickets
WHEN EXISTS (
  SELECT 1 FROM tickets t JOIN ticket_states s ON s.ticket_id = t.id
  WHERE t.repo_id = NEW.repo_id AND t.issue_number = NEW.issue_number AND s.state NOT IN (${FINALS})
)
BEGIN SELECT RAISE(ABORT, 'the issue already has a ticket in flight'); END;
CREATE TRIGGER tickets_start_state AFTER INSERT ON tickets
BEGIN
  INSERT INTO ticket_states (ticket_id, state, call_id, changed_at)
  VALUES (NEW.id, '${INITIAL_STATE}', NULL, NEW.taken_in_at);
END;

-- The state row is created only as a ticket is taken in, and never deleted.
CREATE TRIGGER ticket_states_start BEFORE INSERT ON ticket_states
WHEN NEW.state <> '${INITIAL_STATE}' OR NEW.call_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a ticket starts ${INITIAL_STATE}, with no call'); END;
CREATE TRIGGER ticket_states_no_delete BEFORE DELETE ON ticket_states
BEGIN SELECT RAISE(ABORT, 'a ticket''s state cannot be deleted'); END;

-- A state changes only to what the ticket's newest call recorded, so only as
-- that call is inserted, and only along spec §17's transitions.
CREATE TRIGGER ticket_states_change BEFORE UPDATE ON ticket_states
WHEN NEW.ticket_id IS NOT OLD.ticket_id
  OR NEW.call_id IS NULL
  OR NEW.call_id <= coalesce(OLD.call_id, 0)
  OR NEW.call_id IS NOT (SELECT max(id) FROM calls WHERE ticket_id = OLD.ticket_id)
  OR NOT EXISTS (
    SELECT 1 FROM calls
    WHERE id = NEW.call_id AND ticket_id = OLD.ticket_id
      AND state_from = OLD.state AND state_to = NEW.state AND made_at = NEW.changed_at
  )
BEGIN SELECT RAISE(ABORT, 'a ticket''s state changes only with the call that changes it'); END;
${TRANSITION_TRIGGER}
-- A call that records a state change makes it, in the same statement.
CREATE TRIGGER calls_state_from BEFORE INSERT ON calls
WHEN NEW.state_from IS NOT NULL
  AND NEW.state_from IS NOT (SELECT state FROM ticket_states WHERE ticket_id = NEW.ticket_id)
BEGIN SELECT RAISE(ABORT, 'a call''s state change must start from the ticket''s current state'); END;
CREATE TRIGGER calls_investigate_once BEFORE INSERT ON calls
WHEN NEW.state_to = 'investigating'
  AND EXISTS (SELECT 1 FROM calls WHERE ticket_id = NEW.ticket_id AND state_to = 'investigating')
BEGIN SELECT RAISE(ABORT, 'a ticket is investigated at most once'); END;
CREATE TRIGGER calls_settings_of_repo BEFORE INSERT ON calls
WHEN NEW.settings_version_id IS NOT NULL
  AND (SELECT repo_id FROM settings_versions WHERE id = NEW.settings_version_id)
    IS NOT (SELECT repo_id FROM tickets WHERE id = NEW.ticket_id)
BEGIN SELECT RAISE(ABORT, 'a call''s settings version must be its repo''s'); END;
CREATE TRIGGER calls_answer_of_ticket BEFORE INSERT ON calls
WHEN NEW.answer_id IS NOT NULL
  AND (SELECT b.ticket_id FROM answers a JOIN board_items b ON b.id = a.board_item_id WHERE a.id = NEW.answer_id)
    IS NOT NEW.ticket_id
BEGIN SELECT RAISE(ABORT, 'a call can cite only an answer given on its own ticket'); END;
CREATE TRIGGER calls_apply_state AFTER INSERT ON calls
WHEN NEW.state_to IS NOT NULL
BEGIN
  UPDATE ticket_states SET state = NEW.state_to, call_id = NEW.id, changed_at = NEW.made_at
  WHERE ticket_id = NEW.ticket_id;
END;

-- A board item is raised by the call that put its ticket on the board, and a
-- ticket has at most one open item (ADR-0008).
CREATE TRIGGER board_items_raised_by_call BEFORE INSERT ON board_items
WHEN NOT EXISTS (
  SELECT 1 FROM calls WHERE id = NEW.call_id AND ticket_id = NEW.ticket_id AND state_to = 'on-the-board'
)
BEGIN SELECT RAISE(ABORT, 'a board item is raised by the call that puts its ticket on the board'); END;
CREATE TRIGGER board_items_one_open BEFORE INSERT ON board_items
WHEN EXISTS (
  SELECT 1 FROM board_items b
  WHERE b.ticket_id = NEW.ticket_id
    AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.board_item_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM board_item_withdrawals w WHERE w.board_item_id = b.id)
)
BEGIN SELECT RAISE(ABORT, 'the ticket already has an open board item'); END;

-- An item is answered or withdrawn, never both; a withdrawal comes with the
-- call that cancels its ticket or decides it again.
CREATE TRIGGER answers_open_item BEFORE INSERT ON answers
WHEN EXISTS (SELECT 1 FROM board_item_withdrawals WHERE board_item_id = NEW.board_item_id)
BEGIN SELECT RAISE(ABORT, 'a withdrawn board item takes no answer'); END;
CREATE TRIGGER board_item_withdrawals_open_item BEFORE INSERT ON board_item_withdrawals
WHEN EXISTS (SELECT 1 FROM answers WHERE board_item_id = NEW.board_item_id)
BEGIN SELECT RAISE(ABORT, 'an answered board item cannot be withdrawn'); END;
CREATE TRIGGER board_item_withdrawals_by_call BEFORE INSERT ON board_item_withdrawals
WHEN NOT EXISTS (
  SELECT 1 FROM calls c JOIN board_items b ON b.ticket_id = c.ticket_id
  WHERE c.id = NEW.call_id AND b.id = NEW.board_item_id AND c.state_from = 'on-the-board'
)
BEGIN SELECT RAISE(ABORT, 'a board item is withdrawn by the call that takes its ticket off the board'); END;

-- A forge write is confirmed once; a comment's confirmation names the comment.
CREATE TRIGGER forge_write_confirmations_comment BEFORE INSERT ON forge_write_confirmations
WHEN (SELECT kind FROM forge_write_intents WHERE id = NEW.intent_id) = 'comment' AND NEW.comment_id IS NULL
BEGIN SELECT RAISE(ABORT, 'a comment is confirmed with its id and URL'); END;

-- Created last so they are checked first, for the clearer refusal.
${Object.entries(KEYS).map(noReplace).join("")}`;

/**
 * The SQL that brings a store from the schema version it is keyed on to the
 * next one. Each step runs in the transaction that sets the new version.
 */
export const MIGRATIONS: Readonly<Record<number, string>> = {
  // 1 -> 2: global settings versions.
  1: [
    GLOBAL_SETTINGS_TABLE,
    appendOnly("global_settings_versions"),
    GLOBAL_SETTINGS_IN_ORDER,
    noReplace(["global_settings_versions", KEYS.global_settings_versions]),
  ].join(""),
  // 2 -> 3: enrollments.
  2: [ENROLLMENTS_TABLE, appendOnly("enrollments"), ENROLLMENTS_SETTINGS_OF_REPO, noReplace(["enrollments", KEYS.enrollments])].join(""),
  // 3 -> 4: the model runs enrolling made.
  3: [
    ENROLLMENT_MODEL_RUNS_TABLE,
    appendOnly("enrollment_model_runs"),
    noReplace(["enrollment_model_runs", KEYS.enrollment_model_runs]),
  ].join(""),
  // 4 -> 5: the item version each answer was given to; answers before it were to the first version.
  4: "ALTER TABLE answers ADD COLUMN item_version INTEGER NOT NULL DEFAULT 1 CHECK (item_version > 0);",
  // 5 -> 6: fresh starts.
  5: [FRESH_STARTS_TABLE, appendOnly("fresh_starts"), noReplace(["fresh_starts", KEYS.fresh_starts])].join(""),
  // 6 -> 7: unenrollments.
  6: [UNENROLLMENTS_TABLE, appendOnly("unenrollments"), UNENROLLMENTS_OF_LATEST, noReplace(["unenrollments", KEYS.unenrollments])].join(""),
  // 7 -> 8: on the board -> landing, for a landing pin item withdrawn by a new push or a merge on its answer that did not go through.
  7: `DROP TRIGGER ticket_states_transition;\n${TRANSITION_TRIGGER}`,
  // 8 -> 9: the raw `Vision-Origin` trailer an origin was read from; origins before it kept none.
  8: "ALTER TABLE vision_line_origins ADD COLUMN raw_trailer TEXT;",
};
