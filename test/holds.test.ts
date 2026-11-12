import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_CASE_BOOK, readCaseBook } from "../src/case-book.ts";
import { askBacklog, confirmCall, HOLD_MS, latestCallOn, logPage, overrideCall, repoViews, undoAction, waitingItems, waitingResponse } from "../src/owner.ts";
import { appendEntry, readLog, type CallEntry } from "../src/records.ts";
import { harness, OWNER, REPO, verdict } from "./watch-fixture.ts";

/** The board's two-phase writes as the pass carries them out: recorded at once, acted on when the undo window closes. */

const calls = (dataDirectory: string): CallEntry[] => readLog(dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call");
const NOW = new Date("2026-11-12T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

test("a confirmation held in its window reaches neither GitHub nor the case book until the window closes", async (t) => {
  const h = harness(t);
  h.forge.file(14, "Make tally a desktop app", "With plugins.");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  await h.pass({ now: () => NOW });
  const id = latestCallOn(h.dataDirectory, REPO, 14);
  const action = await confirmCall(h.dataDirectory, id, OWNER, NOW, { holdMs: HOLD_MS });
  assert.equal(action.holdUntil, "2026-11-12T12:00:10.000Z");

  const during = await h.pass({ now: () => at(9_999), actOnly: true });
  assert.equal(during.posted, 0);
  assert.equal(h.forge.posted.length, 1, "only entail's own call is on the issue");
  assert.deepEqual(h.forge.closed, []);
  assert.ok(!existsSync(join(h.dataDirectory, OWNER_CASE_BOOK)));
  assert.equal(waitingResponse(h.dataDirectory, [], { now: at(9_999) }).held.length, 1);

  const after = await h.pass({ now: () => at(10_000), actOnly: true });
  assert.equal(after.posted, 1);
  assert.match(h.forge.posted[1]!.body, /Omkar confirmed this call on the board: no\. Closing the issue as not planned\./u);
  assert.deepEqual(h.forge.closed, [14]);
  const [past] = await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "no");
  assert.equal(waitingResponse(h.dataDirectory, [], { now: at(10_000) }).held.length, 0);
  assert.throws(() => undoAction(h.dataDirectory, id, OWNER, at(5_000)), /too late to undo/u, "once acted on, it cannot be undone, whatever the clock says");
});

test("an undone action is never acted on, and the call waits again", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass({ now: () => NOW });
  const id = latestCallOn(h.dataDirectory, REPO, 12);
  await overrideCall(h.dataDirectory, id, OWNER, "no", "Footnotes are not prose.", NOW, { holdMs: HOLD_MS });
  assert.deepEqual(waitingItems(h.dataDirectory, []), []);
  const { call } = undoAction(h.dataDirectory, id, OWNER, at(4_000));
  assert.equal(call.status, "waiting");
  assert.deepEqual(waitingItems(h.dataDirectory, []).map((item) => item.id), [id]);

  await h.pass({ now: () => at(60_000) });
  assert.equal(h.forge.posted.length, 1);
  assert.deepEqual(h.forge.closed, []);
  assert.ok(!existsSync(join(h.dataDirectory, OWNER_CASE_BOOK)));
  const row = logPage(h.dataDirectory, []).rows[0]!;
  assert.deepEqual(
    row.trail.map((step) => step.text),
    ["Judged: go · claude-opus-5-5, low", "Posted the call on the issue", "Omkar overrode: no", "Omkar undid it; nothing was sent to GitHub"],
    "the log keeps the undone override, and that nothing was sent",
  );
  assert.equal(repoViews(h.dataDirectory, { owner: OWNER, model: "m", effort: "low" })[0]!.checked, 0, "an undone override does not count as a disagreement");
});

test("a restart after the window closed completes the action once, even if it crashed between posting and recording", async (t) => {
  const h = harness(t);
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  await h.pass({ now: () => NOW });
  const id = latestCallOn(h.dataDirectory, REPO, 14);
  await confirmCall(h.dataDirectory, id, OWNER, NOW, { holdMs: HOLD_MS });
  // The process dies after posting the confirmation and before recording it.
  const close = h.forge.closeIssue.bind(h.forge);
  h.forge.closeIssue = async () => {
    throw new Error("killed");
  };
  await h.pass({ now: () => at(10_500), actOnly: true });
  assert.equal(h.forge.posted.length, 2);
  h.forge.closeIssue = close;
  // A fresh pass after the restart.
  const again = await h.pass({ now: () => at(70_000), seen: new Map() });
  assert.equal(again.posted, 1);
  assert.equal(h.forge.posted.length, 2, "the posted confirmation is found by its marker, not posted twice");
  assert.deepEqual(h.forge.closed, [14]);
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "acted").length, 2);
});

test("go, but differently: the owner's line is posted word for word as the criterion, and no judgment runs again", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(169, "The board should be good", "It reloads on every click.");
  h.script(169, verdict({ reason: "Updating in place is better.", criteria: [{ source: "reading", criterion: "Keep the server-rendered board.", basis: "x" }] }));
  await h.pass({ now: () => NOW });
  const id = latestCallOn(h.dataDirectory, REPO, 169);
  await overrideCall(h.dataDirectory, id, OWNER, "go", "Rebuild the board as a single-page app with a front-end framework.", NOW, { holdMs: HOLD_MS, differently: true });
  await h.pass({ now: () => at(11_000) });
  assert.equal(h.runner.requests.length, 1, "entail does not derive criteria from the owner's line");
  const body = h.forge.posted[1]!.body;
  assert.match(body, /\*\*Go\*\*, by Omkar, keeping entail's go but not its criteria\./u);
  assert.match(body, /What the PR must do beyond solving the issue, in Omkar's words:\n\n- Rebuild the board as a single-page app with a front-end framework\./u);
  assert.doesNotMatch(body, /server-rendered/u);
  const [past] = await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "go");
  assert.equal(past!.reason, "Rebuild the board as a single-page app with a front-end framework.");
  assert.match(past!.reasonFrom, /their line is the criterion/u);
  const row = logPage(h.dataDirectory, []).rows[0]!;
  assert.equal(row.call.status, "overridden");
  assert.equal(row.call.settledBy?.differently, true);
});

test("an issue edited while its item waits is judged again and replaces the item in place, marked as re-judged", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Count words with non-breaking spaces");
  h.forge.file(12, "Add a --json flag");
  h.script(11, verdict({ call: "no", reason: "Not better." }), verdict({ call: "no", reason: "Still not better." }));
  h.script(12, verdict({ call: "no", reason: "Nobody asked." }));
  await h.pass();
  const first = latestCallOn(h.dataDirectory, REPO, 11);
  h.forge.edit(11, { body: "Count them as separators." });
  await h.pass();
  const items = waitingItems(h.dataDirectory, []);
  assert.deepEqual(items.map((item) => [item.issue.number, item.rejudged]), [
    [11, true],
    [12, false],
  ], "the edited issue keeps its place, oldest first");
  assert.notEqual(items[0]!.id, first);
  assert.equal(items[0]!.waitingSince, calls(h.dataDirectory).find((call) => call.id === first)!.at);
  await assert.rejects(confirmCall(h.dataDirectory, first, OWNER), /the issue was edited and entail judged it again/u);
  const old = logPage(h.dataDirectory, []).rows.find((row) => row.call.id === first)!;
  assert.equal(old.call.status, "superseded");
  assert.equal(old.trail.at(-1)!.text, "Judged again after an edit");
});

test("the open backlog is judged only when the owner asks, and only the issues still open with no call", async (t) => {
  const h = harness(t);
  h.forge.file(3, "An old idea", "", { createdAt: "2026-01-01T00:00:00Z" });
  h.forge.file(5, "An old bug", "", { createdAt: "2026-01-01T00:00:00Z" });
  h.forge.file(8, "A closed one", "", { createdAt: "2026-01-01T00:00:00Z" });
  h.forge.edit(8, { state: "closed" });
  await h.pass();
  assert.equal(h.runner.requests.length, 0, "issues filed before enrollment are left alone");

  h.script(3, verdict());
  h.script(5, verdict({ call: "no", reason: "Not a bug." }));
  assert.deepEqual(askBacklog(h.dataDirectory, REPO, OWNER, [3, 5, 8]), [3, 5, 8]);
  const report = await h.pass();
  assert.equal(report.judged, 2);
  assert.deepEqual(calls(h.dataDirectory).map((call) => [call.issue.number, call.trigger]), [
    [3, "backlog"],
    [5, "backlog"],
  ]);
  assert.equal((await h.pass()).judged, 0, "each is judged once");
});

test("an issue reopened on GitHub after entail closed it is recorded in the log, not taken as the owner's word", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  await h.pass();
  assert.deepEqual(h.forge.closed, [14]);
  h.forge.edit(14, { state: "open" });
  await h.pass();
  assert.deepEqual(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "reopened").map((entry) => entry.type), ["reopened"]);
  const row = logPage(h.dataDirectory, []).rows[0]!;
  assert.equal(row.reopened, true);
  assert.equal(row.call.status, "auto");
  assert.match(row.trail.at(-1)!.text, /Reopened on GitHub after entail closed it/u);
  await h.pass();
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "reopened").length, 1, "recorded once");
  assert.ok(!existsSync(join(h.dataDirectory, OWNER_CASE_BOOK)));
});

test("an act-only pass reads nothing new from GitHub, and a pass can be limited to one repo", async (t) => {
  const h = harness(t);
  appendEntry(h.dataDirectory, "acme/other", { type: "enrolled", by: OWNER, since: "2026-11-12T09:00:00.000Z", confirm: true });
  h.forge.file(12, "Count words in footnotes");
  const checked: string[] = [];
  const actOnly = await h.pass({ actOnly: true, onChecked: (repo) => checked.push(repo) });
  assert.deepEqual(actOnly, { repos: 2, judged: 0, posted: 0, failed: [] });
  assert.equal(checked.length, 0, "an act-only pass checks nothing");
  h.script(12, verdict());
  const one = await h.pass({ only: [REPO], onChecked: (repo) => checked.push(repo) });
  assert.deepEqual(one, { repos: 1, judged: 1, posted: 1, failed: [] });
  assert.deepEqual(checked, [REPO]);
});

test("the board suggests confirm mode off after five checked calls with at least 80% agreed, counting confirmations and overrides only", async (t) => {
  const h = harness(t);
  for (const number of [1, 2, 3, 4, 5, 6]) {
    h.forge.file(number, `Issue ${number}`);
    h.script(number, verdict());
  }
  h.forge.file(7, "A question");
  h.script(7, verdict({ call: "ask", question: { question: "Which?", why: "Two readings." } }));
  await h.pass();
  const settings = { owner: OWNER, model: "m", effort: "low" as const };
  for (const number of [1, 2, 3, 4]) await confirmCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, number), OWNER);
  assert.equal(repoViews(h.dataDirectory, settings)[0]!.suggestConfirmOff, false, "four checked is not enough");
  await overrideCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 5), OWNER, "no", "No.");
  let view = repoViews(h.dataDirectory, settings)[0]!;
  assert.deepEqual([view.checked, view.agreed, view.suggestConfirmOff], [5, 4, true]);
  await overrideCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 6), OWNER, "no", "No.");
  view = repoViews(h.dataDirectory, settings)[0]!;
  assert.deepEqual([view.checked, view.agreed, view.suggestConfirmOff], [6, 4, false], "4 of 6 is under 80%");
});
