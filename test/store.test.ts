import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { APPEND_ONLY_TABLES, SCHEMA_VERSION } from "../src/store-schema.ts";
import { RepoAlreadyEnrolledError, STORE_FILE, Store, StoreOpenError, type NewEnrollmentModelRun, type NewModelRun, type RepoRecord, type TicketRecord } from "../src/store.ts";
import { TICKET_STATES, TICKET_TRANSITIONS, TransitionError, type TicketState } from "../src/ticket-states.ts";

function tempDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(t: TestContext, dir = tempDirectory(t)): Store {
  let tick = 0;
  // A clock that moves, so every record has its own time.
  const store = Store.openIn(dir, { now: () => new Date(Date.UTC(2026, 10, 8, 12, 0, tick++)) });
  t.after(() => store.close());
  return store;
}

function enroll(store: Store, projectId = 101): RepoRecord {
  return store.enrollRepo({
    forge: "github",
    host: "github.com",
    projectId,
    path: "owner/tally",
    ownerAccountId: 4242,
    ownerLogin: "owner",
  });
}

const RUN: NewModelRun = {
  purpose: "verdict",
  model: "claude-opus-5-5",
  promptVersion: "verdict-1",
  sessionId: "session-1",
  input: "the full prompt",
  output: '{"verdict":"needs-the-owner"}',
  startedAt: "2026-11-08T11:59:00.000Z",
  durationMs: 1234,
  estimatedCostUsd: 0.12,
};

const PROPOSAL_RUN: NewEnrollmentModelRun = {
  purpose: "generic-criteria-proposal",
  model: "claude-opus-5-5",
  promptVersion: "generic-criteria-proposal/1",
  sessionId: "session-0",
  input: "the full prompt",
  output: '{"criteria":[],"reason":"none"}',
  failure: null,
  startedAt: "2026-11-08T11:58:00.000Z",
  durationMs: 900,
  estimatedCostUsd: 0.05,
};

/** Moves a ticket with one call per step, as entail would. */
function move(store: Store, ticket: TicketRecord, ...states: TicketState[]): void {
  for (const stateTo of states) {
    store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: `to ${stateTo}`, stateTo });
  }
}

/** A raw connection to the same file, as any other code could open it. */
function rawConnection(t: TestContext, store: Store): DatabaseSync {
  const db = new DatabaseSync(store.path);
  t.after(() => db.close());
  return db;
}

/** Drops a table with its triggers and indexes, taking a store back to before it was added. */
function dropTable(db: DatabaseSync, table: string): void {
  for (const { type, name } of db
    .prepare("SELECT type, name FROM sqlite_schema WHERE tbl_name = ? AND type IN ('trigger', 'index')")
    .all(table) as { type: string; name: string }[]) {
    if (!name.startsWith("sqlite_")) db.exec(`DROP ${type} ${name}`);
  }
  db.exec(`DROP TABLE ${table}`);
}

/** A store with at least one row in every table. */
function fullStore(t: TestContext): Store {
  const store = openStore(t);
  const { repo, settings } = store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 101, path: "owner/tally", ownerAccountId: 4242, ownerLogin: "owner" },
    settings: { shadow: false, pins: [] },
    savedBy: "Owner",
    visionSha: "v1",
    visionLines: ["Tally counts words."],
    visionOrigin: "agent-proposed-owner-approved",
    openIssueNumbers: [3],
    modelRuns: [PROPOSAL_RUN],
  });
  store.saveGlobalSettings({ ownerDisplayName: "Owner" }, "Owner");
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 1 });
  const toBoard = store.recordCall({
    ticketId: ticket.id,
    kind: "verdict",
    reason: "contradicts a line",
    inputs: { issueTitle: "t", issueBody: "b", visionSha: "v1", pins: [], settingsVersionId: settings.id },
    stateTo: "on-the-board",
    modelRuns: [RUN],
  });
  const item = store.raiseBoardItem({
    ticketId: ticket.id,
    callId: toBoard.id,
    decision: "Should tally count blank lines?",
    whyRaised: "contradiction",
    snapshot: { options: [] },
  });
  store.recordAnswer({ boardItemId: item.id, answeredBy: "Owner", shape: "dont-go-ahead" });
  const second = store.takeIn({ repoId: repo.id, issueNumber: 2 });
  const secondToBoard = store.recordCall({ ticketId: second.id, kind: "verdict", reason: "pin", stateTo: "on-the-board" });
  const secondItem = store.raiseBoardItem({
    ticketId: second.id,
    callId: secondToBoard.id,
    decision: "d",
    whyRaised: "pin",
    snapshot: {},
  });
  const withdrawing = store.recordCall({ ticketId: second.id, kind: "verdict", reason: "issue edited", stateTo: "deciding" });
  store.withdrawBoardItem({ boardItemId: secondItem.id, callId: withdrawing.id, reason: "the issue was edited" });
  store.recordVisionLineOrigin({ repoId: repo.id, line: "A line.", origin: "owner-stated", commitSha: "c1", source: "enrollment" });
  store.recordVisionChange({ repoId: repo.id, commitSha: "c2", blobSha: "b2", previousBlobSha: "b1", removed: [], added: ["New."] });
  const intent = store.recordForgeWriteIntent({ repoId: repo.id, ticketId: ticket.id, callId: toBoard.id, kind: "comment", target: "issue", number: 1, payload: { body: "x" } });
  store.confirmForgeWrite({ intentId: intent.id, comment: { id: "99", url: "https://github.com/owner/tally/issues/1#issuecomment-99" } });
  store.recordFreshStart({ repoId: repo.id, confirmedBy: "Owner", markedIssueNumbers: [4] });
  const ended = store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 102, path: "owner/old", ownerAccountId: 4242, ownerLogin: "owner" },
    settings: {},
    savedBy: "Owner",
    visionSha: "v1",
    visionLines: ["Tally counts words."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [],
  }).repo;
  store.recordUnenrollment({ repoId: ended.id, unenrolledBy: "Owner" });
  return store;
}

test("a new store is created with the current schema, and opened again as it is", (t) => {
  const dir = tempDirectory(t);
  const first = Store.openIn(dir);
  const repo = enroll(first);
  first.close();
  const second = openStore(t, dir);
  assert.deepEqual(second.findRepo({ forge: "github", host: "github.com", projectId: 101 }), repo);
  const db = rawConnection(t, second);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
});

test("a file that is not an entail store is refused", (t) => {
  const dir = tempDirectory(t);
  writeFileSync(join(dir, STORE_FILE), "not a database\n".repeat(100));
  assert.throws(() => Store.openIn(dir), StoreOpenError);

  const other = tempDirectory(t);
  const db = new DatabaseSync(join(other, STORE_FILE));
  db.exec("CREATE TABLE something_else (x INTEGER)");
  db.close();
  assert.throws(() => Store.openIn(other), /not an entail store/);
});

test("a store written by a newer entail is refused", (t) => {
  const dir = tempDirectory(t);
  Store.openIn(dir).close();
  const db = new DatabaseSync(join(dir, STORE_FILE));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => Store.openIn(dir), /written by a newer entail/);
});

test("a store from schema 1 is migrated to the current schema and keeps its records", (t) => {
  const dir = tempDirectory(t);
  const first = Store.openIn(dir);
  const repo = enroll(first);
  first.close();
  // Take the store back to schema 1, which had no global settings, no enrollments, no enrollment model runs and no fresh starts.
  const db = new DatabaseSync(join(dir, STORE_FILE));
  for (const table of ["global_settings_versions", "unenrollments", "enrollment_model_runs", "enrollments", "fresh_starts"]) {
    for (const { type, name } of db
      .prepare("SELECT type, name FROM sqlite_schema WHERE tbl_name = ? AND type IN ('trigger', 'index')")
      .all(table) as { type: string; name: string }[]) {
      if (!name.startsWith("sqlite_")) db.exec(`DROP ${type} ${name}`);
    }
    db.exec(`DROP TABLE ${table}`);
  }
  // Nor the item version an answer was given to.
  db.exec("ALTER TABLE answers DROP COLUMN item_version");
  db.exec("PRAGMA user_version = 1");
  db.close();

  const store = openStore(t, dir);
  assert.deepEqual(store.getRepo(repo.id), repo);
  assert.equal(store.latestGlobalSettings(), null);
  assert.equal(store.saveGlobalSettings({ model: "m" }, "Owner").version, 1);
  assert.equal(store.latestEnrollment(repo.id), null);
  const raw = rawConnection(t, store);
  assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
  assert.throws(() => raw.exec("DELETE FROM global_settings_versions"), /append-only/);
  const triggers = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'enrollments'").all();
  assert.deepEqual(
    triggers.map((row) => row.name).sort(),
    ["enrollments_no_delete", "enrollments_no_replace", "enrollments_no_update", "enrollments_settings_of_repo"],
  );
  const runTriggers = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'enrollment_model_runs'").all();
  assert.deepEqual(
    runTriggers.map((row) => row.name).sort(),
    ["enrollment_model_runs_no_delete", "enrollment_model_runs_no_replace", "enrollment_model_runs_no_update"],
  );
  const freshStartTriggers = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'fresh_starts'").all();
  assert.deepEqual(
    freshStartTriggers.map((row) => row.name).sort(),
    ["fresh_starts_no_delete", "fresh_starts_no_replace", "fresh_starts_no_update"],
  );
  assert.deepEqual(store.freshStarts(repo.id), []);
});

test("an enrollment keeps its model runs whole, an output or a failure, and nothing else", (t) => {
  const store = openStore(t);
  const failed: NewEnrollmentModelRun = {
    ...PROPOSAL_RUN,
    sessionId: null,
    output: null,
    failure: { kind: "timeout", message: "the run took too long" },
    estimatedCostUsd: null,
  };
  const { enrollment } = store.enroll({
    repo: { forge: "gitlab", host: "gitlab.com", projectId: 7, path: "g/tally", ownerAccountId: 1, ownerLogin: "o" },
    settings: {},
    savedBy: "Owner",
    visionSha: "v1",
    visionLines: ["A line."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [],
    modelRuns: [PROPOSAL_RUN, failed],
  });
  const runs = store.enrollmentModelRuns(enrollment.id);
  assert.deepEqual(
    runs.map(({ id: _id, enrollmentId, ...run }) => ({ enrollmentId, ...run })),
    [
      { enrollmentId: enrollment.id, ...PROPOSAL_RUN },
      { enrollmentId: enrollment.id, ...failed },
    ],
  );
  const db = rawConnection(t, store);
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO enrollment_model_runs (enrollment_id, purpose, model, prompt_version, input, output, failure, started_at, duration_ms)
         VALUES (${enrollment.id}, 'p', 'm', 'v', 'i', 'o', '{}', 't', 0)`,
      ),
    /CHECK constraint/,
    "a run has an output or a failure, not both",
  );
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO enrollment_model_runs (enrollment_id, purpose, model, prompt_version, input, started_at, duration_ms)
         VALUES (${enrollment.id}, 'p', 'm', 'v', 'i', 't', 0)`,
      ),
    /CHECK constraint/,
    "a run has an output or a failure",
  );
});

test("global settings are saved as numbered versions with time and name, and older versions stay readable", (t) => {
  const store = openStore(t);
  assert.equal(store.latestGlobalSettings(), null);
  assert.deepEqual(store.globalSettingsHistory(), []);

  const first = store.saveGlobalSettings({ ownerDisplayName: "Ada", model: "claude-opus-5-5" }, "Ada");
  const second = store.saveGlobalSettings({ ownerDisplayName: "Ada L.", model: "claude-opus-5-5" }, "Ada L.");
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(first.savedBy, "Ada");
  assert.ok(first.savedAt < second.savedAt, "each save has its own time");
  assert.deepEqual(store.latestGlobalSettings(), second);
  assert.deepEqual(store.globalSettingsVersion(1), first);
  assert.deepEqual(store.globalSettingsHistory(), [second, first]);
  assert.equal(store.globalSettingsVersion(3), null);

  const db = rawConnection(t, store);
  assert.throws(
    () => db.exec(`INSERT INTO global_settings_versions (version, saved_at, saved_by, settings) VALUES (5, 'x', 'Ada', '{}')`),
    /must follow the latest version/,
  );
  assert.throws(
    () => db.exec(`INSERT INTO global_settings_versions (version, saved_at, saved_by, settings) VALUES (3, 'x', '', '{}')`),
    /CHECK constraint/,
    "a save carries the owner's name",
  );
});

test("every append-only table refuses UPDATE, DELETE and INSERT OR REPLACE from any connection", (t) => {
  const store = fullStore(t);
  const db = rawConnection(t, store);
  const counts = Object.fromEntries(APPEND_ONLY_TABLES.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n]));
  for (const table of APPEND_ONLY_TABLES) {
    const row = db.prepare(`SELECT rowid AS rid, * FROM ${table} LIMIT 1`).get();
    assert.ok(row, `${table} has a row to tamper with`);
    const column = Object.keys(row).find((name) => name !== "rid")!;
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${column} = ${column}`).run(), /append-only/, `UPDATE ${table}`);
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /append-only/, `DELETE ${table}`);
    const columns = Object.keys(row).filter((name) => name !== "rid");
    const values = columns.map((name) => row[name] ?? null);
    assert.throws(
      () => db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values),
      /append-only/,
      `INSERT OR REPLACE ${table}`,
    );
    assert.deepEqual(db.prepare(`SELECT rowid AS rid, * FROM ${table} LIMIT 1`).get(), row, `${table} is unchanged`);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, counts[table], `${table} keeps every row`);
  }
});

test("a ticket's state cannot be changed, deleted or replaced except by a call", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 7 });
  const db = rawConnection(t, store);

  assert.throws(() => db.exec(`UPDATE ticket_states SET state = 'cleared' WHERE ticket_id = ${ticket.id}`), /only with the call/);
  assert.throws(() => db.exec(`DELETE FROM ticket_states WHERE ticket_id = ${ticket.id}`), /cannot be deleted/);
  assert.throws(
    () => db.exec(`INSERT OR REPLACE INTO ticket_states (ticket_id, state, call_id, changed_at) VALUES (${ticket.id}, 'deciding', NULL, 'x')`),
    /cannot be replaced/,
  );

  // A call that changes no state cannot be borrowed to change it afterwards.
  const call = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "still deciding" });
  assert.throws(
    () =>
      db.exec(
        `UPDATE ticket_states SET state = 'cleared', call_id = ${call.id}, changed_at = '${call.madeAt}' WHERE ticket_id = ${ticket.id}`,
      ),
    /only with the call/,
  );
  assert.equal(store.getTicket(ticket.id)?.state, "deciding");
});

test("a call records its state change in the same statement that makes it", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 7 });
  assert.equal(ticket.state, "deciding");
  assert.equal(ticket.stateCallId, null);

  const call = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "settled", stateTo: "cleared" });
  assert.deepEqual(call.stateChange, { from: "deciding", to: "cleared" });
  const after = store.getTicket(ticket.id);
  assert.equal(after?.state, "cleared");
  assert.equal(after?.stateCallId, call.id);
  assert.equal(after?.stateChangedAt, call.madeAt);

  // A call written outside the store's API changes the state too, and a call
  // whose state change the state machine refuses is not written at all.
  const db = rawConnection(t, store);
  db.exec(
    `INSERT INTO calls (ticket_id, made_at, kind, reason, state_from, state_to) VALUES (${ticket.id}, 'later', 'landing', 'PR open', 'cleared', 'landing')`,
  );
  assert.equal(store.getTicket(ticket.id)?.state, "landing");
  const calls = store.callsForTicket(ticket.id).length;
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO calls (ticket_id, made_at, kind, reason, state_from, state_to) VALUES (${ticket.id}, 'later', 'x', 'y', 'landing', 'investigating')`,
      ),
    /does not allow/,
  );
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO calls (ticket_id, made_at, kind, reason, state_from, state_to) VALUES (${ticket.id}, 'later', 'x', 'y', 'cleared', 'on-the-board')`,
      ),
    /current state/,
  );
  assert.equal(store.callsForTicket(ticket.id).length, calls);
});

test("a call that fails part-way leaves neither the call, its model runs nor the state change", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 7 });
  assert.throws(() =>
    store.recordCall({
      ticketId: ticket.id,
      kind: "verdict",
      reason: "settled",
      stateTo: "cleared",
      modelRuns: [RUN, { ...RUN, durationMs: -1 }],
    }),
  );
  assert.equal(store.getTicket(ticket.id)?.state, "deciding");
  assert.deepEqual(store.callsForTicket(ticket.id), []);
});

test("ticket states and transitions follow spec §17, and final states cannot be left", (t) => {
  assert.deepEqual(
    [...TICKET_STATES].sort(),
    ["cancelled", "cleared", "deciding", "declined", "investigating", "landing", "merged", "on-the-board"],
  );
  const expected: Record<TicketState, TicketState[]> = {
    deciding: ["declined", "investigating", "cancelled", "cleared", "on-the-board", "merged"],
    investigating: ["deciding", "cancelled", "merged"],
    "on-the-board": ["deciding", "cancelled", "merged"],
    cleared: ["landing", "on-the-board", "cancelled", "merged"],
    landing: ["merged", "on-the-board", "cleared", "cancelled"],
    declined: [],
    cancelled: [],
    merged: [],
  };
  assert.deepEqual(TICKET_TRANSITIONS, expected);

  // The store holds every pair to the same table, whatever code writes it.
  const store = openStore(t);
  const repo = enroll(store);
  let issue = 0;
  const reach: Record<TicketState, TicketState[]> = {
    deciding: [],
    investigating: ["investigating"],
    "on-the-board": ["on-the-board"],
    cleared: ["cleared"],
    landing: ["cleared", "landing"],
    declined: ["declined"],
    cancelled: ["cancelled"],
    merged: ["merged"],
  };
  for (const from of TICKET_STATES) {
    for (const to of TICKET_STATES) {
      const ticket = store.takeIn({ repoId: repo.id, issueNumber: ++issue });
      move(store, ticket, ...reach[from]);
      assert.equal(store.getTicket(ticket.id)?.state, from);
      const allowed = expected[from].includes(to);
      const attempt = () => store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "r", stateTo: to });
      if (allowed) {
        attempt();
        assert.equal(store.getTicket(ticket.id)?.state, to, `${from} → ${to}`);
      } else {
        assert.throws(attempt, TransitionError, `${from} → ${to}`);
        const db = rawConnection(t, store);
        assert.throws(
          () =>
            db.exec(
              `INSERT INTO calls (ticket_id, made_at, kind, reason, state_from, state_to) VALUES (${ticket.id}, 'x', 'x', 'x', '${from}', '${to}')`,
            ),
          /does not allow|at most once/,
          `the store refuses ${from} → ${to}`,
        );
        assert.equal(store.getTicket(ticket.id)?.state, from);
      }
    }
  }
});

test("a ticket is investigated at most once", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 3 });
  move(store, ticket, "investigating", "deciding");
  assert.throws(
    () => store.recordCall({ ticketId: ticket.id, kind: "investigation", reason: "again", stateTo: "investigating" }),
    /investigated at most once/,
  );
});

test("a call holds everything spec §3 lists, including each model run's full input and output", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const settings = store.saveSettings(repo.id, { pins: [{ topic: "the output format" }] }, "Owner");
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 12 });
  const longInput = `prompt ${"x".repeat(200_000)}`;
  const call = store.recordCall({
    ticketId: ticket.id,
    kind: "verdict",
    reason: "VISION.md says counts are per file",
    citation: { visionSha: "abc123", lines: ["tally counts lines per file."] },
    checks: [{ check: "citation is verbatim", passed: true }],
    challenge: { overturned: false, objection: null },
    inputs: {
      issueTitle: "Count per file",
      issueBody: "  exactly as read\n",
      visionSha: "abc123",
      pins: [{ topic: "the output format" }],
      settingsVersionId: settings.id,
      prHeadSha: null,
    },
    detail: { verdict: "settled", reading: "per file" },
    stateTo: "cleared",
    modelRuns: [
      { ...RUN, input: longInput },
      { ...RUN, purpose: "challenge", sessionId: null, output: "no objection", estimatedCostUsd: 0.05 },
    ],
  });
  const intent = store.recordForgeWriteIntent({
    repoId: repo.id,
    ticketId: ticket.id,
    callId: call.id,
    kind: "comment",
    target: "issue",
    number: 12,
    payload: { body: "intake comment" },
  });
  assert.deepEqual(store.getCall(call.id)?.postedComments, [], "an unconfirmed comment was not posted");
  store.confirmForgeWrite({ intentId: intent.id, comment: { id: "555", url: "https://github.com/owner/tally/issues/12#issuecomment-555" } });

  const record = store.getCall(call.id)!;
  assert.equal(record.ticketId, ticket.id);
  assert.equal(record.repoId, repo.id);
  assert.match(record.madeAt, /^2026-11-08T/);
  assert.equal(record.kind, "verdict");
  assert.equal(record.reason, "VISION.md says counts are per file");
  assert.deepEqual(record.citation, { visionSha: "abc123", lines: ["tally counts lines per file."] });
  assert.equal(record.answerId, null);
  assert.equal(record.noContradictionFound, false);
  assert.deepEqual(record.checks, [{ check: "citation is verbatim", passed: true }]);
  assert.deepEqual(record.challenge, { overturned: false, objection: null });
  assert.deepEqual(record.inputs, {
    issueTitle: "Count per file",
    issueBody: "  exactly as read\n",
    visionSha: "abc123",
    pins: [{ topic: "the output format" }],
    settingsVersionId: settings.id,
    prHeadSha: null,
  });
  assert.deepEqual(record.detail, { verdict: "settled", reading: "per file" });
  assert.deepEqual(record.stateChange, { from: "deciding", to: "cleared" });
  assert.equal(record.modelRuns.length, 2);
  assert.equal(record.modelRuns[0]?.input, longInput);
  assert.deepEqual(record.modelRuns[1], {
    ...RUN,
    purpose: "challenge",
    sessionId: null,
    output: "no objection",
    estimatedCostUsd: 0.05,
    id: record.modelRuns[1]!.id,
    callId: call.id,
  });
  assert.deepEqual(record.postedComments.map(({ commentId, commentUrl }) => ({ commentId, commentUrl })), [
    { commentId: "555", commentUrl: "https://github.com/owner/tally/issues/12#issuecomment-555" },
  ]);
  assert.deepEqual(store.unconfirmedForgeWrites(), []);
});

test("an unopposed clear records no contradiction found in place of a citation", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 4 });
  const call = store.recordCall({
    ticketId: ticket.id,
    kind: "verdict",
    reason: "no line opposes a --version flag",
    noContradictionFound: true,
    stateTo: "cleared",
  });
  assert.equal(call.noContradictionFound, true);
  assert.equal(call.citation, null);
  assert.throws(() =>
    store.recordCall({
      ticketId: ticket.id,
      kind: "recheck",
      reason: "r",
      noContradictionFound: true,
      citation: { visionSha: "v", lines: ["l"] },
    }),
  );
});

test("an issue has one ticket in flight, and one pulled in again links to its predecessor", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const first = store.takeIn({ repoId: repo.id, issueNumber: 5 });
  assert.equal(first.predecessorId, null);
  assert.throws(() => store.takeIn({ repoId: repo.id, issueNumber: 5 }), /in flight/);

  move(store, first, "declined");
  assert.throws(() => store.takeIn({ repoId: repo.id, issueNumber: 5 }), /predecessor/);
  const second = store.takeIn({ repoId: repo.id, issueNumber: 5, predecessorId: first.id });
  assert.equal(second.predecessorId, first.id);
  assert.equal(second.state, "deciding");
  assert.equal(store.getTicket(first.id)?.state, "declined", "the predecessor stays final");
  assert.equal(store.latestTicketForIssue(repo.id, 5)?.id, second.id);

  // A first ticket links to none, and a link must name the issue's latest ticket.
  assert.throws(() => store.takeIn({ repoId: repo.id, issueNumber: 6, predecessorId: first.id }), /predecessor/);
  move(store, second, "cancelled");
  assert.throws(() => store.takeIn({ repoId: repo.id, issueNumber: 5, predecessorId: first.id }), /predecessor/);
});

test("repos are keyed on forge, host and numeric project id, so a renamed repo keeps its records", (t) => {
  const store = openStore(t);
  const repo = enroll(store, 900);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 1 });

  assert.throws(
    () => store.enrollRepo({ forge: "github", host: "github.com", projectId: 900, path: "new-owner/renamed", ownerAccountId: 1, ownerLogin: "o" }),
    /UNIQUE|replaced/,
  );
  const found = store.findRepo({ forge: "github", host: "github.com", projectId: 900 });
  assert.equal(found?.id, repo.id);
  assert.equal(store.latestTicketForIssue(found!.id, 1)?.id, ticket.id);

  // The same numeric id on another forge or host is another repo.
  const gitlab = store.enrollRepo({ forge: "gitlab", host: "gitlab.com", projectId: 900, path: "owner/tally", ownerAccountId: 1, ownerLogin: "o" });
  const selfHosted = store.enrollRepo({ forge: "gitlab", host: "git.example.org", projectId: 900, path: "owner/tally", ownerAccountId: 1, ownerLogin: "o" });
  assert.equal(new Set([repo.id, gitlab.id, selfHosted.id]).size, 3);
  assert.equal(store.findRepo({ forge: "github", host: "github.com", projectId: 901 }), null);
});

test("settings are saved as numbered versions, and a call's settings version must be its repo's", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const other = enroll(store, 202);
  const v1 = store.saveSettings(repo.id, { shadow: false }, "Owner");
  const v2 = store.saveSettings(repo.id, { shadow: true }, "Owner");
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.deepEqual(store.latestSettings(repo.id)?.settings, { shadow: true });
  const elsewhere = store.saveSettings(other.id, {}, "Owner");
  assert.equal(elsewhere.version, 1);

  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 1 });
  assert.throws(
    () => store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "r", inputs: { settingsVersionId: elsewhere.id } }),
    /settings version/,
  );
});

test("a board item is raised by its call, answered or withdrawn once, and cited by the call its answer causes", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 8 });
  const stillDeciding = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "r" });
  const item = { ticketId: ticket.id, decision: "Which reading?", whyRaised: "consequential-readings", snapshot: { options: ["a", "b"] } };
  assert.throws(() => store.raiseBoardItem({ ...item, callId: stillDeciding.id }), /raised by the call/);

  const raise = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "readings differ", stateTo: "on-the-board" });
  const raised = store.raiseBoardItem({ ...item, callId: raise.id });
  assert.throws(() => store.raiseBoardItem({ ...item, callId: raise.id }), /open board item/);
  assert.equal(store.openBoardItem(ticket.id)?.id, raised.id);

  const answer = store.recordAnswer({ boardItemId: raised.id, answeredBy: "Owner", shape: "option", optionId: "a", note: "private", showNoteOnIssue: false });
  assert.equal(answer.answeredBy, "Owner");
  assert.equal(store.openBoardItem(ticket.id), null);
  assert.throws(() => store.recordAnswer({ boardItemId: raised.id, answeredBy: "Owner", shape: "dont-go-ahead" }), /UNIQUE|replaced/);

  const goAhead = store.recordCall({ ticketId: ticket.id, kind: "criteria", reason: "the owner chose a", answerId: answer.id, stateTo: "deciding" });
  assert.equal(goAhead.answerId, answer.id);
  assert.throws(() => store.withdrawBoardItem({ boardItemId: raised.id, callId: goAhead.id, reason: "late" }), /answered/);

  // An answer from another ticket cannot be cited.
  const other = store.takeIn({ repoId: repo.id, issueNumber: 9 });
  assert.throws(() => store.recordCall({ ticketId: other.id, kind: "criteria", reason: "r", answerId: answer.id }), /own ticket/);

  // A withdrawn item takes no answer.
  const otherRaise = store.recordCall({ ticketId: other.id, kind: "verdict", reason: "pin", stateTo: "on-the-board" });
  const otherItem = store.raiseBoardItem({ ...item, ticketId: other.id, callId: otherRaise.id });
  const edited = store.recordCall({ ticketId: other.id, kind: "verdict", reason: "the issue was edited", stateTo: "deciding" });
  store.withdrawBoardItem({ boardItemId: otherItem.id, callId: edited.id, reason: "the issue was edited" });
  assert.throws(() => store.recordAnswer({ boardItemId: otherItem.id, answeredBy: "Owner", shape: "dont-go-ahead" }), /withdrawn/);
});

test("an answer records the item version it was given to, and one from before schema 5 reads as the first version", (t) => {
  const dir = tempDirectory(t);
  const first = Store.openIn(dir);
  const repo = enroll(first);
  const raiseItem = (issueNumber: number) => {
    const ticket = first.takeIn({ repoId: repo.id, issueNumber });
    const call = first.recordCall({ ticketId: ticket.id, kind: "raise", reason: "r", stateTo: "on-the-board" });
    return first.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision: "Go ahead?", whyRaised: "pin", snapshot: { version: 3 } });
  };
  const versioned = first.recordAnswer({ boardItemId: raiseItem(1).id, itemVersion: 3, answeredBy: "Owner", shape: "dont-go-ahead" });
  assert.equal(versioned.itemVersion, 3);
  assert.throws(() => first.recordAnswer({ boardItemId: raiseItem(2).id, itemVersion: 0, answeredBy: "Owner", shape: "dont-go-ahead" }), /CHECK/);
  first.close();

  // Take the store back to schema 4, whose answers had no item version, and which had no fresh starts and no unenrollments.
  const db = new DatabaseSync(join(dir, STORE_FILE));
  dropTable(db, "unenrollments");
  db.exec("DROP TABLE fresh_starts");
  db.exec("ALTER TABLE answers DROP COLUMN item_version");
  db.exec("PRAGMA user_version = 4");
  db.close();
  const store = openStore(t, dir);
  assert.equal(store.answerFor(versioned.boardItemId)?.itemVersion, 1);
});

test("enrolling records the repo, its first settings version, every vision line's origin and the open issues at once", (t) => {
  const store = openStore(t);
  const { repo, settings, enrollment } = store.enroll({
    repo: { forge: "gitlab", host: "git.example.org", projectId: 77, path: "group/tally", ownerAccountId: 9, ownerLogin: "ada" },
    settings: { visionOrigin: "owner-stated", mergeMethod: null },
    savedBy: "Ada",
    visionSha: "c1",
    visionLines: ["Tally counts words.", "Tally reads files.", "Tally counts words."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [5, 2, 5],
  });
  assert.deepEqual(store.findRepo({ forge: "gitlab", host: "git.example.org", projectId: 77 }), repo);
  assert.equal(repo.ownerAccountId, 9);
  assert.deepEqual(store.listRepos(), [repo]);
  assert.equal(settings.version, 1);
  assert.equal(settings.savedBy, "Ada");
  assert.deepEqual(store.latestSettings(repo.id), settings);
  assert.deepEqual(store.settingsVersion(repo.id, 1), settings);
  assert.deepEqual(store.settingsHistory(repo.id), [settings]);
  for (const line of ["Tally counts words.", "Tally reads files."]) {
    const origin = store.visionLineOrigin(repo.id, line);
    assert.equal(origin?.origin, "owner-stated");
    assert.equal(origin?.source, "enrollment");
    assert.equal(origin?.commitSha, "c1");
  }
  assert.deepEqual(enrollment, {
    id: enrollment.id,
    repoId: repo.id,
    enrolledAt: repo.enrolledAt,
    visionSha: "c1",
    settingsVersionId: settings.id,
    openIssueNumbers: [2, 5],
  });
  assert.deepEqual(store.latestEnrollment(repo.id), enrollment);
  assert.equal(store.wasOpenAtEnrollment(repo.id, 2), true);
  assert.equal(store.wasOpenAtEnrollment(repo.id, 5), true);
  assert.equal(store.wasOpenAtEnrollment(repo.id, 3), false);
});

test("a failed enrollment records nothing", (t) => {
  const store = openStore(t);
  const existing = enroll(store);
  assert.throws(() =>
    store.enroll({
      repo: { forge: "github", host: "github.com", projectId: 101, path: "owner/tally", ownerAccountId: 4242, ownerLogin: "owner" },
      settings: {},
      savedBy: "Owner",
      visionSha: "c1",
      visionLines: ["A line."],
      visionOrigin: "owner-stated",
      openIssueNumbers: [],
    }),
  );
  assert.deepEqual(store.listRepos(), [existing]);
  assert.equal(store.latestSettings(existing.id), null);
  assert.equal(store.visionLineOrigin(existing.id, "A line."), null);
  assert.equal(store.latestEnrollment(existing.id), null);
});

test("vision line origins and vision changes are recorded per repo", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  store.recordVisionLineOrigin({ repoId: repo.id, line: "tally counts lines.", origin: "agent-proposed-owner-approved", commitSha: "c1", source: "enrollment" });
  store.recordVisionLineOrigin({ repoId: repo.id, line: "tally counts lines.", origin: "owner-stated", commitSha: "c3", source: "no-trailer" });
  assert.equal(store.visionLineOrigin(repo.id, "tally counts lines.")?.origin, "owner-stated", "the latest origin is current");
  assert.equal(store.visionLineOrigin(repo.id, "another line."), null);

  const change = store.recordVisionChange({
    repoId: repo.id,
    commitSha: "c3",
    blobSha: "b3",
    previousBlobSha: "b1",
    removed: ["Old line."],
    added: ["tally counts lines."],
  });
  assert.deepEqual([change.removed, change.added], [["Old line."], ["tally counts lines."]]);
});

test("forge writes are intents until confirmed, and a comment is confirmed with its id and URL", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  const label = store.recordForgeWriteIntent({ repoId: repo.id, kind: "label", target: "issue", number: 3, payload: { add: ["entail:cleared"] } });
  const comment = store.recordForgeWriteIntent({ repoId: repo.id, kind: "comment", target: "issue", number: 3, payload: { body: "b" } });
  assert.deepEqual(store.unconfirmedForgeWrites().map((i) => i.id), [label.id, comment.id]);

  assert.throws(() => store.confirmForgeWrite({ intentId: comment.id }), /id and URL/);
  store.confirmForgeWrite({ intentId: label.id });
  assert.throws(() => store.confirmForgeWrite({ intentId: label.id }), /UNIQUE|replaced/);
  assert.deepEqual(store.unconfirmedForgeWrites().map((i) => i.id), [comment.id]);
});

test("transactions roll back as a whole, nested ones included", (t) => {
  const store = openStore(t);
  const repo = enroll(store);
  assert.throws(() =>
    store.transaction(() => {
      store.takeIn({ repoId: repo.id, issueNumber: 1 });
      throw new Error("boom");
    }),
  );
  assert.equal(store.latestTicketForIssue(repo.id, 1), null);

  store.transaction(() => {
    store.takeIn({ repoId: repo.id, issueNumber: 2 });
    assert.throws(() => store.transaction(() => store.takeIn({ repoId: repo.id, issueNumber: 2 })));
    store.takeIn({ repoId: repo.id, issueNumber: 3 });
  });
  assert.ok(store.latestTicketForIssue(repo.id, 2));
  assert.ok(store.latestTicketForIssue(repo.id, 3));
});

test("an unenrollment ends the repo's latest enrollment once; enrolling again keeps the repo and starts a new enrollment", (t) => {
  const store = openStore(t);
  const enrollment = (projectId: number, openIssueNumbers: number[]) =>
    store.enroll({
      repo: { forge: "github", host: "github.com", projectId, path: "owner/tally", ownerAccountId: 4242, ownerLogin: "owner" },
      settings: {},
      savedBy: "Owner",
      visionSha: "v1",
      visionLines: ["Tally counts words."],
      visionOrigin: "owner-stated",
      openIssueNumbers,
    });
  const first = enrollment(101, [1]);
  const other = enrollment(102, []);
  assert.throws(() => enrollment(101, []), RepoAlreadyEnrolledError, "an enrolled repo cannot be enrolled twice");
  assert.equal(store.isEnrolled(first.repo.id), true);

  const ended = store.recordUnenrollment({ repoId: first.repo.id, unenrolledBy: "Owner" });
  assert.equal(ended.enrollmentId, first.enrollment.id);
  assert.equal(store.isEnrolled(first.repo.id), false);
  assert.deepEqual(store.listEnrolledRepos(), [other.repo]);
  assert.deepEqual(store.listRepos(), [first.repo, other.repo], "its record stays");
  assert.throws(() => store.recordUnenrollment({ repoId: first.repo.id, unenrolledBy: "Owner" }), /latest enrollment, once/);
  assert.deepEqual(store.latestUnenrollment(first.repo.id), ended);

  const again = enrollment(101, [1, 2]);
  assert.equal(again.repo.id, first.repo.id);
  assert.notEqual(again.enrollment.id, first.enrollment.id);
  assert.equal(store.isEnrolled(first.repo.id), true);
  assert.equal(store.wasOpenAtEnrollment(first.repo.id, 2), true, "the new enrollment's open issues are the ones left alone");
  assert.equal(store.latestSettings(first.repo.id)!.version, 2, "enrolling again saves a new settings version");

  const raw = rawConnection(t, store);
  assert.throws(
    () => raw.prepare("INSERT INTO unenrollments (repo_id, enrollment_id, unenrolled_at, unenrolled_by) VALUES (?, ?, 'x', 'Owner')").run(first.repo.id, first.enrollment.id),
    /latest enrollment, once/,
    "an earlier enrollment cannot be ended after a newer one started",
  );
  assert.throws(() => raw.exec("DELETE FROM unenrollments"), /append-only/);
});
