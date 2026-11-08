import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { APPEND_ONLY_TABLES, SCHEMA_VERSION } from "../src/store-schema.ts";
import { STORE_FILE, Store, StoreOpenError, type NewModelRun, type RepoRecord, type TicketRecord } from "../src/store.ts";
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

/** A store with at least one row in every table. */
function fullStore(t: TestContext): Store {
  const store = openStore(t);
  const repo = enroll(store);
  const settings = store.saveSettings(repo.id, { shadow: false, pins: [] }, "Owner");
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
