import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_GLOBAL_SETTINGS } from "../src/global-settings.ts";
import {
  exportRecords,
  importRecords,
  MANIFEST_FILE,
  RecordsImportError,
  tableFile,
  type RecordsManifest,
} from "../src/records.ts";
import {
  readRecordsPushState,
  RECORDS_BRANCH,
  RECORDS_COMMIT_INTERVAL_MS,
  RECORDS_DIRECTORY,
  RECORDS_PUSH_FILE,
  RecordsRepo,
} from "../src/records-repo.ts";
import { SCHEMA_VERSION } from "../src/store-schema.ts";
import { CURSORS_FILE } from "../src/cursors.ts";
import { LOCK_FILE, LockHeldError } from "../src/lock.ts";
import { restoreRecords, RestoreError } from "../src/records-restore.ts";
import { Store } from "../src/store.ts";
import { git, tempDirectory } from "./git-fixture.ts";

const VISION_SHA = "a".repeat(40);

/** A store holding at least one row of every kind of record, under a clock that moves a second per write. */
function populatedStore(dir: string): Store {
  let now = Date.UTC(2026, 10, 9, 9, 0, 0);
  const store = Store.openIn(dir, { now: () => new Date((now += 1000)) });
  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada" }, "Ada");
  const { repo } = store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: 1001, ownerLogin: "ada" },
    settings: { pins: [{ name: "the output format", path: "src/format.js" }] },
    savedBy: "Ada",
    visionSha: VISION_SHA,
    visionLines: ["tally never reaches the network.", "A word is a run of characters between whitespace."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [1, 2],
    modelRuns: [
      {
        purpose: "generic-criteria-proposal",
        model: "claude-opus-5-5",
        promptVersion: "1",
        sessionId: "s-0",
        input: "propose",
        output: '{"criteria":[]}',
        failure: null,
        startedAt: "2026-11-09T09:00:00.000Z",
        durationMs: 1200,
        estimatedCostUsd: 0.25,
      },
    ],
  });
  store.saveSettings(repo.id, { pins: [] }, "Ada");

  // A ticket raised to the board and answered, then cleared citing the answer.
  const answered = store.takeIn({ repoId: repo.id, issueNumber: 7 });
  const raise = store.recordCall({
    ticketId: answered.id,
    kind: "raise",
    reason: "Contradicts a vision line.",
    stateTo: "on-the-board",
    citation: { visionSha: VISION_SHA, lines: ["tally never reaches the network."] },
    inputs: { issueTitle: "Count web pages", issueBody: "Line one\nline “two”\n", visionSha: VISION_SHA, pins: [], settingsVersionId: 1 },
    checks: [{ name: "quoted", passed: true }],
    challenge: { upheld: true },
    modelRuns: [
      {
        purpose: "verdict",
        model: "claude-opus-5-5",
        promptVersion: "3",
        sessionId: "s-1",
        input: "judge",
        output: '{"verdict":"needs-owner"}',
        startedAt: "2026-11-09T09:00:05.000Z",
        durationMs: 3000,
        estimatedCostUsd: 0.125,
      },
    ],
  });
  const item = store.raiseBoardItem({ ticketId: answered.id, callId: raise.id, decision: "Go ahead?", whyRaised: "contradiction", snapshot: { version: 2 } });
  const intent = store.recordForgeWriteIntent({ repoId: repo.id, ticketId: answered.id, callId: raise.id, kind: "comment", target: "issue", number: 7, payload: { body: "hi" } });
  store.confirmForgeWrite({ intentId: intent.id, comment: { id: "8001", url: "https://github.com/acme/tally/issues/7#issuecomment-8001" } });
  const answer = store.recordAnswer({ boardItemId: item.id, itemVersion: 2, answeredBy: "Ada", shape: "own-words", text: "Rename only.", note: "private", showNoteOnIssue: false });
  store.recordCall({ ticketId: answered.id, kind: "verdict", reason: "The owner went ahead.", answerId: answer.id, stateTo: "deciding" });
  store.recordCall({ ticketId: answered.id, kind: "criteria", reason: "Criteria written.", answerId: answer.id, stateTo: "cleared" });

  // A ticket whose board item was withdrawn as it was cancelled, then pulled in again.
  const withdrawn = store.takeIn({ repoId: repo.id, issueNumber: 8 });
  const raised = store.recordCall({ ticketId: withdrawn.id, kind: "raise", reason: "Needs the owner.", stateTo: "on-the-board" });
  const second = store.raiseBoardItem({ ticketId: withdrawn.id, callId: raised.id, decision: "Go ahead?", whyRaised: "pin", snapshot: {} });
  const cancel = store.recordCall({ ticketId: withdrawn.id, kind: "cancel-on-outside-close", reason: "Closed on the forge.", stateTo: "cancelled" });
  store.withdrawBoardItem({ boardItemId: second.id, callId: cancel.id, reason: "The issue was closed." });
  store.takeIn({ repoId: repo.id, issueNumber: 8, predecessorId: withdrawn.id });

  store.recordVisionLineOrigin({ repoId: repo.id, line: "Colours are fine.", origin: "agent-proposed-owner-approved", commitSha: "b".repeat(40), source: "trailer" });
  store.recordVisionChange({ repoId: repo.id, commitSha: "b".repeat(40), blobSha: "c".repeat(40), previousBlobSha: "d".repeat(40), removed: [], added: ["Colours are fine."] });
  store.recordFreshStart({ repoId: repo.id, confirmedBy: "Ada", markedIssueNumbers: [4, 3] });
  return store;
}

function exportDirectory(t: TestContext, files: Map<string, string>): string {
  const dir = tempDirectory(t, "export");
  for (const [path, text] of files) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function manifestOf(files: Map<string, string>): RecordsManifest {
  return JSON.parse(files.get(MANIFEST_FILE)!) as RecordsManifest;
}

test("the export is the whole store as text, one file per table and a manifest", (t) => {
  const store = populatedStore(tempDirectory(t, "store"));
  const files = exportRecords(store.path);
  store.close();

  const manifest = manifestOf(files);
  assert.equal(manifest.format, 1);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  const tables = Object.keys(manifest.tables);
  assert.ok(tables.includes("calls") && tables.includes("answers") && tables.includes("ticket_states"), "every table, the current states included");
  assert.deepEqual([...files.keys()], [MANIFEST_FILE, ...tables.map(tableFile)].sort(), "nothing but the manifest and the tables");
  for (const table of tables) {
    assert.ok(manifest.tables[table]! > 0, `${table} holds a row in this store`);
    const lines = files.get(tableFile(table))!.split("\n");
    assert.equal(lines.pop(), "", "each file ends with a newline");
    assert.equal(lines.length, manifest.tables[table]);
  }
  const answer = JSON.parse(files.get(tableFile("answers"))!.split("\n")[0]!);
  assert.equal(answer.text, "Rename only.");
  assert.equal(answer.note, "private", "private notes are records, kept in the export");
});

test("the export is deterministic: the same store always gives the same bytes, in primary key order", (t) => {
  const dir = tempDirectory(t, "store");
  const store = populatedStore(dir);
  const first = exportRecords(store.path);
  const second = exportRecords(store.path);
  assert.deepEqual(second, first);

  const ids = files(first, "calls").map((row) => row.id as number);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  store.close();
});

function files(exported: Map<string, string>, table: string): Record<string, unknown>[] {
  return exported
    .get(tableFile(table))!
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("an export round-trips through import into a fresh store", (t) => {
  const store = populatedStore(tempDirectory(t, "store"));
  const exported = exportRecords(store.path);
  const restoredPath = join(tempDirectory(t, "restored"), "store.sqlite");
  importRecords(exportDirectory(t, exported), restoredPath);
  assert.deepEqual(exportRecords(restoredPath), exported, "exporting the imported store gives the same text");

  const restored = Store.open(restoredPath);
  t.after(() => restored.close());
  for (const ticket of [1, 2, 3]) {
    assert.deepEqual(restored.getTicket(ticket), store.getTicket(ticket), `ticket ${ticket} and its current state`);
    assert.deepEqual(restored.callsForTicket(ticket), store.callsForTicket(ticket), `ticket ${ticket}'s calls, model runs and posted comments`);
    assert.deepEqual(restored.boardItemsForTicket(ticket), store.boardItemsForTicket(ticket), `ticket ${ticket}'s board items and answers`);
  }
  assert.deepEqual(restored.settingsHistory(1), store.settingsHistory(1));
  assert.deepEqual(restored.globalSettingsHistory(), store.globalSettingsHistory());
  assert.deepEqual(restored.listRepos(), store.listRepos());
  store.close();
});

test("an imported store keeps the store's rules and carries on from its records", (t) => {
  const store = populatedStore(tempDirectory(t, "store"));
  const exported = exportRecords(store.path);
  store.close();
  const restoredPath = join(tempDirectory(t, "restored"), "store.sqlite");
  importRecords(exportDirectory(t, exported), restoredPath);
  const restored = Store.open(restoredPath);
  t.after(() => restored.close());

  assert.throws(() => restored.takeIn({ repoId: 1, issueNumber: 8, predecessorId: 2 }), /already has a ticket in flight/, "ticket 3 is in flight");
  assert.throws(() => restored.recordCall({ ticketId: 2, kind: "verdict", reason: "x", stateTo: "deciding" }), /spec §17|final/i, "a final state is final");
  const next = restored.takeIn({ repoId: 1, issueNumber: 9 });
  assert.equal(next.id, 4, "new records follow the restored ones");
  assert.equal(next.state, "deciding");
  const db = new DatabaseSync(restoredPath);
  t.after(() => db.close());
  assert.throws(() => db.exec("DELETE FROM answers"), /append-only/);
});

test("import refuses an existing store, an export from a newer entail, or one that does not add up, and leaves no store", (t) => {
  const store = populatedStore(tempDirectory(t, "store"));
  const exported = exportRecords(store.path);
  store.close();
  const target = () => join(tempDirectory(t, "restored"), "store.sqlite");

  assert.throws(() => importRecords(exportDirectory(t, exported), store.path), RecordsImportError, "never over an existing store");

  const newer = new Map(exported);
  newer.set(MANIFEST_FILE, JSON.stringify({ ...manifestOf(exported), schemaVersion: SCHEMA_VERSION + 1 }));
  const newerPath = target();
  assert.throws(() => importRecords(exportDirectory(t, newer), newerPath), /newer entail/);
  assert.equal(existsSync(newerPath), false);

  const short = new Map(exported);
  short.set(tableFile("calls"), files(exported, "calls").slice(1).map((row) => `${JSON.stringify(row)}\n`).join(""));
  const shortPath = target();
  assert.throws(() => importRecords(exportDirectory(t, short), shortPath), /calls\.jsonl holds \d+ rows/);
  assert.equal(existsSync(shortPath), false);

  const dangling = new Map(exported);
  const manifest = manifestOf(exported);
  dangling.set(tableFile("tickets"), "");
  dangling.set(MANIFEST_FILE, JSON.stringify({ ...manifest, tables: { ...manifest.tables, tickets: 0 } }));
  const danglingPath = target();
  assert.throws(() => importRecords(exportDirectory(t, dangling), danglingPath), /refer to records the export does not hold/);
  assert.equal(existsSync(danglingPath), false);
});

// The records repo

interface Repo {
  dataDirectory: string;
  store: Store;
  records: RecordsRepo;
  setRemote(remote: string | null): void;
}

function recordsRepo(t: TestContext, options: { pushTimeoutMs?: number } = {}): Repo {
  const dataDirectory = tempDirectory(t, "data");
  const store = populatedStore(dataDirectory);
  t.after(() => store.close());
  let remote: string | null = null;
  const records = new RecordsRepo({
    dataDirectory,
    storePath: store.path,
    remote: () => remote,
    now: () => new Date(Date.UTC(2026, 10, 9, 12, 0, 0)),
    ...options,
  });
  t.after(() => records.stopHourly());
  return { dataDirectory, store, records, setRemote: (r) => (remote = r) };
}

function log(dir: string, ref = "HEAD"): string[] {
  return git(dir, "log", "--format=%s", ref).split("\n").filter(Boolean);
}

function bareRemote(t: TestContext): string {
  const remote = join(tempDirectory(t, "remote"), "records.git");
  git(join(remote, ".."), "init", "--quiet", "--bare", `--initial-branch=${RECORDS_BRANCH}`, remote);
  return remote;
}

test("a save commits the export to the records repo in the data directory, and only when the records changed", async (t) => {
  const { dataDirectory, store, records } = recordsRepo(t);
  const first = await records.save("answer");
  assert.ok(!("error" in first) && first.commit !== null);
  assert.equal(first.push, "no-remote", "without a remote, commits stay local");
  const dir = join(dataDirectory, RECORDS_DIRECTORY);
  assert.equal(records.directory, dir);
  assert.deepEqual(log(dir), ["entail records: after an answer"]);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), RECORDS_BRANCH);
  assert.equal(git(dir, "status", "--porcelain"), "", "everything exported is committed");
  for (const [path, text] of exportRecords(store.path)) assert.equal(git(dir, "show", `HEAD:${path}`) + "\n", text);

  const unchanged = await records.save("hourly");
  assert.ok(!("error" in unchanged) && unchanged.commit === null, "nothing changed, so no commit");

  store.takeIn({ repoId: 1, issueNumber: 10 });
  const changed = await records.save("hourly");
  assert.ok(!("error" in changed) && changed.commit !== null);
  assert.deepEqual(log(dir), ["entail records: hourly", "entail records: after an answer"]);
  assert.match(git(dir, "show", "--stat", "--format=", "HEAD"), /tables\/tickets\.jsonl/);
  assert.equal(existsSync(join(dataDirectory, RECORDS_PUSH_FILE)), false, "no push was tried");
  assert.deepEqual(readRecordsPushState(dataDirectory), { lastSuccess: null, lastFailure: null });
});

test("the records repo holds only the export: the status file and the rest of the data directory stay out", async (t) => {
  const { dataDirectory, records } = recordsRepo(t);
  writeFileSync(join(dataDirectory, "status.json"), "{}\n");
  await records.save("answer");
  const tracked = git(join(dataDirectory, RECORDS_DIRECTORY), "ls-files").split("\n");
  assert.ok(tracked.every((path) => path === MANIFEST_FILE || /^tables\/[a-z_]+\.jsonl$/.test(path)), tracked.join(", "));
  assert.deepEqual(readdirSync(join(dataDirectory, RECORDS_DIRECTORY)).sort(), [".git", MANIFEST_FILE, "tables"]);
});

test("a save pushes to the remote set in the global settings, and entail keeps when the last push succeeded", async (t) => {
  const { dataDirectory, records, setRemote } = recordsRepo(t);
  const remote = bareRemote(t);
  setRemote(remote);
  const saved = await records.save("answer");
  assert.ok(!("error" in saved));
  assert.equal(saved.push, "pushed");
  const head = git(join(dataDirectory, RECORDS_DIRECTORY), "rev-parse", "HEAD");
  assert.equal(git(remote, "rev-parse", `refs/heads/${RECORDS_BRANCH}`), head);
  assert.deepEqual(readRecordsPushState(dataDirectory), {
    lastSuccess: { at: "2026-11-09T12:00:00.000Z", remote, commit: head },
    lastFailure: null,
  });

  // Restoring: clone the records repo and import it into a fresh store.
  const clone = join(tempDirectory(t, "clone"), "records");
  git(join(clone, ".."), "clone", "--quiet", "--branch", RECORDS_BRANCH, remote, clone);
  const restored = join(tempDirectory(t, "restored"), "store.sqlite");
  importRecords(clone, restored);
  assert.deepEqual(exportRecords(restored), exportRecords(join(dataDirectory, "store.sqlite")));
});

test("a failed push is kept beside the last success, and the commit stays local", async (t) => {
  const { dataDirectory, store, records, setRemote } = recordsRepo(t);
  const remote = bareRemote(t);
  setRemote(remote);
  await records.save("answer");
  const success = readRecordsPushState(dataDirectory).lastSuccess;
  store.takeIn({ repoId: 1, issueNumber: 14 });

  const missing = join(tempDirectory(t, "gone"), "nowhere.git");
  setRemote(missing);
  const failed = await records.save("stop");
  assert.ok(!("error" in failed));
  assert.equal(failed.push, "failed");
  const state = readRecordsPushState(dataDirectory);
  assert.deepEqual(state.lastSuccess, success, "the last success still stands");
  assert.equal(state.lastFailure?.remote, missing);
  assert.match(state.lastFailure!.error, /git push/);
  assert.equal(git(remote, "rev-parse", `refs/heads/${RECORDS_BRANCH}`), success!.commit, "the remote has only what was pushed");
  assert.notEqual(git(join(dataDirectory, RECORDS_DIRECTORY), "rev-parse", "HEAD"), success!.commit, "the new commit is local");
});

test("entail commits at least every hour while it runs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { dataDirectory, store, records } = recordsRepo(t);
  records.startHourly();
  const dir = join(dataDirectory, RECORDS_DIRECTORY);

  t.mock.timers.tick(RECORDS_COMMIT_INTERVAL_MS - 1);
  await records.idle();
  assert.equal(existsSync(join(dir, ".git")), false, "not before the hour");

  t.mock.timers.tick(1);
  await records.idle();
  assert.deepEqual(log(dir), ["entail records: hourly"]);

  store.takeIn({ repoId: 1, issueNumber: 11 });
  t.mock.timers.tick(RECORDS_COMMIT_INTERVAL_MS);
  await records.idle();
  assert.deepEqual(log(dir), ["entail records: hourly", "entail records: hourly"]);

  records.stopHourly();
  store.takeIn({ repoId: 1, issueNumber: 12 });
  t.mock.timers.tick(RECORDS_COMMIT_INTERVAL_MS);
  await records.idle();
  assert.equal(log(dir).length, 2, "no commit once stopped");
});

test("saves run one at a time, in the order asked", async (t) => {
  const { dataDirectory, store, records } = recordsRepo(t);
  const first = records.save("answer");
  store.takeIn({ repoId: 1, issueNumber: 13 });
  const second = records.save("stop");
  await Promise.all([first, second]);
  const subjects = log(join(dataDirectory, RECORDS_DIRECTORY));
  assert.equal(subjects.at(-1), "entail records: after an answer");
  assert.ok(subjects.length <= 2);
  const dir = join(dataDirectory, RECORDS_DIRECTORY);
  assert.equal(readFileSync(join(dir, tableFile("tickets")), "utf8"), exportRecords(store.path).get(tableFile("tickets")));
});

// Restoring

/** A records repo pushed to a bare remote from a store holding every kind of record. */
async function pushedRecords(t: TestContext): Promise<Repo & { remote: string }> {
  const repo = recordsRepo(t);
  const remote = bareRemote(t);
  repo.setRemote(remote);
  const saved = await repo.records.save("answer");
  assert.ok(!("error" in saved) && saved.push === "pushed");
  return { ...repo, remote };
}

test("restoring clones the records repo and imports it into a fresh store with every ticket, call, answer and settings version", async (t) => {
  const { store, remote } = await pushedRecords(t);
  const dataDirectory = tempDirectory(t, "new-machine");

  const restored = await restoreRecords({ dataDirectory, remote });
  assert.equal(restored.storePath, join(dataDirectory, "store.sqlite"));
  assert.equal(restored.setAside, null, "the data directory held nothing to set aside");
  assert.equal(restored.commit, git(remote, "rev-parse", `refs/heads/${RECORDS_BRANCH}`));
  assert.deepEqual(exportRecords(restored.storePath), exportRecords(store.path), "the restored store is the same records");

  const fresh = Store.openIn(dataDirectory);
  t.after(() => fresh.close());
  for (const ticket of [1, 2, 3]) {
    assert.deepEqual(fresh.getTicket(ticket), store.getTicket(ticket), `ticket ${ticket} and its current state`);
    assert.deepEqual(fresh.callsForTicket(ticket), store.callsForTicket(ticket), `ticket ${ticket}'s calls`);
    assert.deepEqual(fresh.boardItemsForTicket(ticket), store.boardItemsForTicket(ticket), `ticket ${ticket}'s board items and answers`);
  }
  assert.deepEqual(fresh.settingsHistory(1), store.settingsHistory(1), "every settings version");
  assert.deepEqual(fresh.globalSettingsHistory(), store.globalSettingsHistory(), "every global settings version");
  assert.deepEqual(fresh.freshStarts(1), store.freshStarts(1));

  // The records repo carries on from the remote's history, so the next push is a fast-forward.
  const records = new RecordsRepo({ dataDirectory, storePath: fresh.path, remote: () => remote });
  fresh.takeIn({ repoId: 1, issueNumber: 11 });
  const saved = await records.save("answer");
  assert.ok(!("error" in saved));
  assert.equal(saved.push, "pushed");
  assert.deepEqual(log(remote, `refs/heads/${RECORDS_BRANCH}`), ["entail records: after an answer", "entail records: after an answer"]);
});

test("restoring refuses a data directory that holds records unless asked to replace them, and then sets them aside", async (t) => {
  const { store, remote } = await pushedRecords(t);
  const dataDirectory = tempDirectory(t, "started-fresh");
  const before = Store.openIn(dataDirectory);
  before.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada" }, "Ada");
  before.close();
  writeFileSync(join(dataDirectory, CURSORS_FILE), "{}\n");

  await assert.rejects(restoreRecords({ dataDirectory, remote }), (error: unknown) => error instanceof RestoreError && /--replace/.test(error.message));
  const untouched = Store.openIn(dataDirectory);
  assert.equal(untouched.globalSettingsHistory().length, 1, "the store is as it was");
  untouched.close();
  assert.equal(existsSync(join(dataDirectory, RECORDS_DIRECTORY)), false);

  const restored = await restoreRecords({ dataDirectory, remote, replace: true, now: () => new Date(Date.UTC(2026, 10, 9, 13, 0, 0)) });
  assert.equal(restored.setAside, join(dataDirectory, "before-restore-2026-11-09T13-00-00-000Z"));
  assert.ok(readdirSync(restored.setAside!).includes("store.sqlite"), "the earlier store is set aside, not deleted");
  assert.ok(readdirSync(restored.setAside!).includes(CURSORS_FILE), "with the cursors that belong to it");
  assert.equal(existsSync(join(dataDirectory, CURSORS_FILE)), false);
  assert.deepEqual(exportRecords(join(dataDirectory, "store.sqlite")), exportRecords(store.path));
  assert.ok(!readdirSync(dataDirectory).some((name) => name.startsWith("restoring-")), "nothing is left staged");
});

test("restoring refuses while entail is running, and a remote it cannot fetch leaves the data directory as it was", async (t) => {
  const { remote } = await pushedRecords(t);
  const running = tempDirectory(t, "running");
  // A live process holds the lock, as a running entail would.
  writeFileSync(join(running, LOCK_FILE), `${JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })}\n`);
  await assert.rejects(restoreRecords({ dataDirectory: running, remote }), LockHeldError);
  assert.equal(existsSync(join(running, "store.sqlite")), false);

  const dataDirectory = tempDirectory(t, "missing-remote");
  await assert.rejects(
    restoreRecords({ dataDirectory, remote: join(dataDirectory, "no-such-remote.git") }),
    (error: unknown) => error instanceof RestoreError && /could not be fetched/.test(error.message),
  );
  assert.deepEqual(readdirSync(dataDirectory), [], "no store, no records repo and nothing staged");
  await assert.rejects(restoreRecords({ dataDirectory, remote: "--upload-pack=touch /tmp/x" }), RestoreError);
});
