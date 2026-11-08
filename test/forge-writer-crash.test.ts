import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { markedTickets } from "../src/comment-rules.ts";
import { settleUnconfirmedWrites } from "../src/forge-writer.ts";
import { Store } from "../src/store.ts";
import { CRASH_HEAD, CRASH_OWNER } from "./forge/crash-writer.ts";
import { StateForge } from "./forge/state-forge.ts";

const CHILD = fileURLToPath(new URL("./forge/crash-writer.ts", import.meta.url));

/**
 * A store with one repo and one ticket, and a forge with an open PR #4 at
 * {@link CRASH_HEAD}, both kept in a data directory a child process can open.
 */
function prepare(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = Store.openIn(dir);
  const repo = store.enrollRepo({ forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: 1001, ownerLogin: "owner" });
  store.takeIn({ repoId: repo.id, issueNumber: 2 });
  store.close();
  new StateForge({ file: join(dir, "forge.json") }, { prs: { 4: { state: "open", headSha: CRASH_HEAD, mergeCommitSha: null } } });
  return dir;
}

/** Runs one write in a child process that is killed between the forge's send and the store's confirm. */
function crashDuring(dir: string, kind: string): void {
  const child = spawnSync(process.execPath, [CHILD, dir, kind], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", `the child was killed mid-write, not ${child.status}: ${child.stderr}`);
}

/** Starts again: opens the store and settles unconfirmed intents against the same forge, as start-up does. */
async function start(dir: string): Promise<{ store: Store; forge: StateForge }> {
  const store = Store.openIn(dir);
  const forge = new StateForge({ file: join(dir, "forge.json") });
  const before = store.unconfirmedForgeWrites();
  assert.equal(before.length, 1, "the killed write was left unconfirmed");
  const settled = await settleUnconfirmedWrites(store, () => forge);
  assert.deepEqual(settled.map((s) => ("error" in s ? s.error.message : s.intentId)), [before[0]?.id]);
  assert.deepEqual(store.unconfirmedForgeWrites(), [], "start-up settled it");
  return { store, forge };
}

test("a comment killed between send and confirm is found by its marker on start, not posted twice", async (t) => {
  const dir = prepare(t);
  crashDuring(dir, "comment");
  assert.equal(new StateForge({ file: join(dir, "forge.json") }).state.comments["issue:2"]?.length, 1, "the forge took the comment");

  const { store, forge } = await start(dir);
  t.after(() => store.close());
  const comments = forge.state.comments["issue:2"] ?? [];
  assert.equal(comments.length, 1, "the comment was not duplicated");
  assert.equal(forge.state.sends.comment, 1);
  assert.deepEqual(markedTickets(comments[0]?.body ?? ""), [1]);
  assert.ok(comments[0]?.body.startsWith(`Speaking from ${CRASH_OWNER}' entail:`));
  assert.deepEqual(store.confirmedCommentIds(1, "issue", 2), [String(comments[0]?.id)], "the confirmation names the comment found");
});

test("a label killed between send and confirm is applied again on start, and carried once", async (t) => {
  const dir = prepare(t);
  crashDuring(dir, "label");
  const { store, forge } = await start(dir);
  t.after(() => store.close());
  assert.deepEqual(forge.state.labels[2], ["entail:cleared"]);
  assert.deepEqual(forge.state.repoLabels, ["entail:cleared"]);
});

test("a close killed between send and confirm is applied again on start, and the issue stays closed once", async (t) => {
  const dir = prepare(t);
  crashDuring(dir, "close");
  const { store, forge } = await start(dir);
  t.after(() => store.close());
  assert.deepEqual(forge.state.closed, { 2: "not-planned" });
});

test("a merge killed between send and confirm is found by the PR's state on start, and never sent again", async (t) => {
  const dir = prepare(t);
  crashDuring(dir, "merge");
  const { store, forge } = await start(dir);
  t.after(() => store.close());
  assert.equal(forge.state.sends.merge, 1, "the merge was not sent twice");
  assert.deepEqual(forge.state.prs[4], { state: "merged", headSha: CRASH_HEAD, mergeCommitSha: `merge-of-${CRASH_HEAD}` });
});
