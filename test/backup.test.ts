import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { backUp, BACKUP_IGNORE, checkRemote, readBackupState, restore, RestoreRefusedError, shownRemote } from "../src/backup.ts";
import { OperationalLog } from "../src/operational-log.ts";
import { appendEntry, writeSettings } from "../src/records.ts";
import { git, tempDirectory } from "./git-fixture.ts";

/** A data directory as entail leaves it after some work: records, and this machine's own files beside them. */
function dataDirectory(t: TestContext): string {
  const dir = join(tempDirectory(t, "backup-data"), "entail");
  mkdirSync(dir, { recursive: true });
  appendEntry(dir, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-01T00:00:00.000Z", confirm: true });
  writeSettings(dir, { owner: "Omkar", model: "claude-opus-5-5", effort: "high", notice: null, start: null, backup: null });
  mkdirSync(join(dir, "cases", "acme-tally-3"), { recursive: true });
  writeFileSync(join(dir, "cases", "acme-tally-3", "call.md"), "go\n");
  mkdirSync(join(dir, "cases", ".acme-tally-4.new-1-2"), { recursive: true });
  writeFileSync(join(dir, "cases", ".acme-tally-4.new-1-2", "call.md"), "half written\n");
  mkdirSync(join(dir, "pins", "github.com", "acme"), { recursive: true });
  writeFileSync(join(dir, "pins", "github.com", "acme", "tally.md"), "- pricing\n");
  mkdirSync(join(dir, "mirrors", "github.com", "acme", "tally.git"), { recursive: true });
  writeFileSync(join(dir, "mirrors", "github.com", "acme", "tally.git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "entail.lock"), '{"pid":1}\n');
  writeFileSync(join(dir, "operational-log.jsonl"), "{}\n");
  writeFileSync(join(dir, "cursors.json"), "{}\n");
  writeFileSync(join(dir, "notices.json"), "{}\n");
  return dir;
}

/** A bare repository standing in for the owner's backup remote. */
function bareRemote(t: TestContext): string {
  const dir = join(tempDirectory(t, "backup-remote"), "records.git");
  git(tempDirectory(t, "backup-cwd"), "init", "--quiet", "--bare", dir);
  return dir;
}

function remoteFiles(remote: string): string[] {
  return git(remote, "ls-tree", "-r", "--name-only", "main").split("\n").sort();
}

function quietLog(dir: string): { log: OperationalLog; events: () => { event: string; reason?: string }[] } {
  const lines: string[] = [];
  const log = new OperationalLog(dir, { echo: (line) => lines.push(line) });
  return { log, events: () => lines.map((line) => JSON.parse(line) as { event: string; reason?: string }) };
}

const RECORDS = [".gitignore", "cases/acme-tally-3/call.md", "log/github.com/acme/tally.jsonl", "pins/github.com/acme/tally.md", "settings.json"];

test("with no remote set nothing is backed up and no repository is made", async (t) => {
  const dir = dataDirectory(t);
  assert.deepEqual(await backUp(dir, null), { kind: "off" });
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.equal(existsSync(join(dir, ".gitignore")), false);
});

test("once a remote is set, the records are committed and pushed after each change, and nothing else is", async (t) => {
  const dir = dataDirectory(t);
  const remote = bareRemote(t);
  const { log, events } = quietLog(dir);

  const first = await backUp(dir, remote, { log });
  assert.equal(first.kind, "pushed");
  assert.deepEqual(remoteFiles(remote), RECORDS);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), BACKUP_IGNORE);
  assert.equal(git(remote, "log", "-1", "--format=%s", "main").startsWith("Back up entail's records at "), true);
  const state = readBackupState(dir);
  assert.equal(state.remote, remote);
  assert.equal(state.pushed, git(remote, "rev-parse", "main"));
  assert.equal(state.problem, null);

  assert.deepEqual(await backUp(dir, remote, { log }), { kind: "unchanged" });

  appendEntry(dir, "acme/tally", { type: "unenrolled", by: "Omkar" });
  writeFileSync(join(dir, "operational-log.jsonl"), "{}\n{}\n");
  const second = await backUp(dir, remote, { log });
  assert.equal(second.kind, "pushed");
  assert.equal(git(remote, "rev-list", "--count", "main"), "2");
  assert.match(git(remote, "show", "main:log/github.com/acme/tally.jsonl"), /"unenrolled"/u);
  assert.deepEqual(events().map((entry) => entry.event), ["backup-pushed", "backup-pushed"]);
});

test("a remote that moved on is neither merged nor overwritten: backup stops pushing, says why, and resumes once a push fast-forwards", async (t) => {
  const dir = dataDirectory(t);
  const remote = bareRemote(t);
  const { log, events } = quietLog(dir);
  await backUp(dir, remote, { log });
  const ours = git(remote, "rev-parse", "main");

  // Another machine pushes to the same remote.
  const other = join(tempDirectory(t, "backup-other"), "clone");
  git(tempDirectory(t, "backup-cwd"), "clone", "--quiet", "--branch", "main", remote, other);
  writeFileSync(join(other, "settings.json"), '{"owner":"Someone else"}\n');
  git(other, "commit", "--quiet", "-am", "another machine");
  git(other, "push", "--quiet", "origin", "main");
  const theirs = git(remote, "rev-parse", "main");

  appendEntry(dir, "acme/tally", { type: "unenrolled", by: "Omkar" });
  const before = readFileSync(join(dir, "log", "github.com", "acme", "tally.jsonl"), "utf8");
  const stuck = await backUp(dir, remote, { log });
  assert.equal(stuck.kind, "stuck");
  assert.match(stuck.kind === "stuck" ? stuck.reason : "", /has moved on since entail last pushed .*does not merge or overwrite it/u);
  assert.equal(git(remote, "rev-parse", "main"), theirs, "the remote keeps the other machine's push");
  assert.equal(readFileSync(join(dir, "log", "github.com", "acme", "tally.jsonl"), "utf8"), before, "the records here are untouched");
  assert.match(readFileSync(join(dir, "settings.json"), "utf8"), /"Omkar"/u);
  assert.equal(readBackupState(dir).problem?.kind, "stuck");

  // Still stuck on the next pass, without saying so again.
  appendEntry(dir, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-02T00:00:00.000Z", confirm: true });
  assert.equal((await backUp(dir, remote, { log })).kind, "stuck");
  assert.deepEqual(events().map((entry) => entry.event), ["backup-pushed", "backup-stuck"]);

  // The owner puts the remote back by hand; the next push fast-forwards it.
  git(other, "push", "--quiet", "--force", "origin", `${ours}:refs/heads/main`);
  const resumed = await backUp(dir, remote, { log });
  assert.equal(resumed.kind, "pushed");
  assert.equal(readBackupState(dir).problem, null);
  assert.equal(git(remote, "rev-parse", "main"), git(dir, "rev-parse", "HEAD"));
  assert.deepEqual(events().map((entry) => entry.event).slice(2), ["backup-resumed", "backup-pushed"]);
});

test("a push that cannot reach the remote fails and is tried again; it is not stuck", async (t) => {
  const dir = dataDirectory(t);
  const missing = join(tempDirectory(t, "backup-missing"), "nowhere.git");
  const outcome = await backUp(dir, missing);
  assert.equal(outcome.kind, "failed");
  assert.equal(readBackupState(dir).problem?.kind, "failed");

  // The remote is made: the next backup pushes what was committed.
  git(tempDirectory(t, "backup-cwd"), "init", "--quiet", "--bare", missing);
  assert.equal((await backUp(dir, missing)).kind, "pushed");
  assert.deepEqual(remoteFiles(missing), RECORDS);
});

test("a fresh install restores every record from the remote, and refuses a data directory that holds anything", async (t) => {
  const dir = dataDirectory(t);
  const remote = bareRemote(t);
  await backUp(dir, remote);

  const fresh = join(tempDirectory(t, "backup-fresh"), "entail");
  mkdirSync(fresh);
  const report = await restore(fresh, remote);
  assert.deepEqual(report.repos, [{ repo: "acme/tally", entries: 1 }]);
  assert.equal(report.cases, 1);
  assert.equal(report.pins, 1);
  assert.equal(report.settings, true);
  for (const file of RECORDS) assert.equal(readFileSync(join(fresh, file), "utf8"), readFileSync(join(dir, file), "utf8"), file);
  for (const own of ["entail.lock", "mirrors", "operational-log.jsonl", "cursors.json", "notices.json"]) assert.equal(existsSync(join(fresh, own)), false, own);

  // The restored copy carries on backing up without pushing what the remote already holds.
  assert.deepEqual(await backUp(fresh, remote), { kind: "unchanged" });

  await assert.rejects(restore(dir, remote), RestoreRefusedError);
  const occupied = join(tempDirectory(t, "backup-occupied"), "entail");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "settings.json"), "{}\n");
  await assert.rejects(restore(occupied, remote), /is not empty \(settings\.json\)/u);
  assert.equal(readFileSync(join(occupied, "settings.json"), "utf8"), "{}\n");
});

test("a remote is shown with any password hidden, and must be one line not read as an option", () => {
  assert.equal(shownRemote("https://me:s3cret@example.com/me/records.git"), "https://me:***@example.com/me/records.git");
  assert.equal(shownRemote("git@github.com:me/records.git"), "git@github.com:me/records.git");
  assert.equal(shownRemote("/srv/backups/entail.git"), "/srv/backups/entail.git");
  assert.equal(checkRemote(" git@github.com:me/records.git "), "git@github.com:me/records.git");
  for (const bad of ["", "  ", "--upload-pack=touch x", "a\nb"]) assert.equal(checkRemote(bad), null, bad);
});
