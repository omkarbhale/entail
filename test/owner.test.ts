import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Case } from "../src/case-book.ts";
import type { IssueCall } from "../src/judgment.ts";
import {
  answerCall,
  changeRepoSettings,
  checkSettingsChange,
  confirmCall,
  enroll,
  formatLog,
  formatWaiting,
  logItems,
  overrideCall,
  OwnerError,
  repoName,
  repoViews,
  unenroll,
  waitingItems,
} from "../src/owner.ts";
import { appendEntry, logFile, pendingWork, readLog, type CallEntry } from "../src/records.ts";

const SETTINGS = { owner: "Omkar", model: "claude-opus-5-5", effort: "low" as const };
const VISION = "# Vision\n\ntally counts words offline.\nNew features are opt-in.\n";

function dataDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "entail-owner-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const restsOn = { visionLines: [], cases: [] };
const GO: IssueCall = { call: "go", reason: "Better.", restsOn, criteria: [] };
const NO: IssueCall = { call: "no", reason: "Not better.", restsOn };
const ASK: IssueCall = { call: "ask", reason: "Unsure.", restsOn, question: "Which reading?", why: "They differ.", large: false, criteria: [] };

let clock = Date.parse("2026-11-12T10:00:00Z");
function call(directory: string, repo: string, issue: number, decided: IssueCall, options: { confirm?: boolean } = {}): CallEntry {
  clock += 60_000;
  return appendEntry(
    directory,
    repo,
    {
      type: "call",
      issue: { number: issue, title: `Issue ${issue}`, url: `https://github.com/${repo}/issues/${issue}`, author: "reporter" },
      trigger: "new",
      mentions: [],
      content: `hash-${issue}`,
      issueText: `# Issue ${issue}\n\nIts body.\n`,
      vision: { text: VISION, commit: "c".repeat(40) },
      sha: "c".repeat(40),
      call: decided,
      confirm: options.confirm ?? true,
      owner: null,
      model: "claude-opus-5-5",
      effort: "low",
      promptVersion: "issue-call-2",
      costUsd: 0.04,
    },
    new Date(clock),
  ) as CallEntry;
}

test("a repo is named owner/name, from a URL too, and kept in lower case", () => {
  assert.equal(repoName("Acme/Tally"), "acme/tally");
  assert.equal(repoName("https://github.com/acme/tally.git"), "acme/tally");
  for (const bad of ["acme", "acme/tally/x", "../x", "acme/..", "a b/c"]) assert.throws(() => repoName(bad), OwnerError, bad);
});

test("enrolling, settings and unenrolling are logged under the owner's name, and only real changes are", (t) => {
  const directory = dataDirectory(t);
  const state = enroll(directory, "acme/tally", "Omkar", { since: new Date("2026-11-12T09:00:00Z") }, new Date("2026-11-12T09:00:00Z"));
  assert.deepEqual(state, { repo: "acme/tally", enrolled: true, since: "2026-11-12T09:00:00.000Z", confirm: true, model: null, effort: null });
  assert.throws(() => enroll(directory, "acme/tally", "Omkar"), /already enrolled/u);

  changeRepoSettings(directory, "acme/tally", "Omkar", { confirm: true, model: "claude-sonnet-5-5" });
  changeRepoSettings(directory, "acme/tally", "Omkar", { model: "claude-sonnet-5-5" });
  const settings = readLog(directory, "acme/tally").filter((entry) => entry.type === "settings");
  assert.equal(settings.length, 1, "confirm was already on and the model was already set the second time");
  assert.deepEqual({ ...settings[0], id: 0, at: "" }, { id: 0, at: "", type: "settings", by: "Omkar", model: "claude-sonnet-5-5" });

  const [view] = repoViews(directory, SETTINGS);
  assert.deepEqual(view!.uses, { model: "claude-sonnet-5-5", effort: "low" });

  unenroll(directory, "acme/tally", "Omkar");
  assert.deepEqual(repoViews(directory, SETTINGS), []);
  assert.equal(repoViews(directory, SETTINGS, { all: true }).length, 1);
  assert.throws(() => unenroll(directory, "acme/tally", "Omkar"), /not enrolled/u);
  assert.throws(() => changeRepoSettings(directory, "acme/tally", "Omkar", { confirm: false }), /not enrolled/u);
});

test("a settings change is checked as it arrives", () => {
  assert.deepEqual(checkSettingsChange({ confirm: false, model: null, effort: "high" }), { confirm: false, model: null, effort: "high" });
  assert.throws(() => checkSettingsChange({ confirm: "off" }), /confirm is true or false/u);
  assert.throws(() => checkSettingsChange({ effort: "huge" }), /effort is one of/u);
  assert.throws(() => checkSettingsChange({ model: "a model; rm -rf" }), /model is a model name/u);
  assert.throws(() => checkSettingsChange({ colour: "pink" }), /no setting named colour/u);
});

test("what waits on the owner: questions first, then calls to confirm, oldest first, and only in enrolled repos", (t) => {
  const directory = dataDirectory(t);
  enroll(directory, "acme/tally", "Omkar");
  enroll(directory, "acme/notes", "Omkar");
  const go = call(directory, "acme/tally", 1, GO);
  call(directory, "acme/tally", 2, NO, { confirm: false });
  const ask = call(directory, "acme/notes", 3, ASK, { confirm: false });
  const no = call(directory, "acme/notes", 4, NO);
  assert.deepEqual(
    waitingItems(directory, []).map((item) => item.id),
    [ask.id, go.id, no.id],
  );
  assert.deepEqual(
    waitingItems(directory, [], "acme/tally").map((item) => item.id),
    [go.id],
  );
  unenroll(directory, "acme/notes", "Omkar");
  assert.deepEqual(
    waitingItems(directory, []).map((item) => item.id),
    [go.id],
  );
  assert.match(formatWaiting(waitingItems(directory, [])), /acme\/tally#1: Issue 1\n {2}https:\/\/github\.com\/acme\/tally\/issues\/1\n {2}GO, to confirm \(call \d+\): Better\./u);
});

test("an item links the vision lines and the past cases its call rests on", (t) => {
  const directory = dataDirectory(t);
  enroll(directory, "acme/tally", "Omkar");
  const rested = call(directory, "acme/tally", 5, { ...GO, restsOn: { visionLines: ["New features are opt-in."], cases: ["acme-tally-3", "gone-case"] } });
  const past: Case = {
    slug: "acme-tally-3",
    repo: "acme/tally",
    issue: 3,
    issueText: "# Three\n",
    vision: "",
    visionCommit: "c".repeat(40),
    call: "no",
    reason: "r",
    reasonFrom: "the owner",
    date: "2026-11-01",
    notes: "",
  };
  const [item] = waitingItems(directory, [past]);
  assert.equal(item!.id, rested.id);
  assert.deepEqual(item!.restsOn, {
    visionLines: [{ text: "New features are opt-in.", url: `https://github.com/acme/tally/blob/${"c".repeat(40)}/VISION.md#L4`, line: 4 }],
    cases: [
      { slug: "acme-tally-3", title: "acme/tally#3", url: "https://github.com/acme/tally/issues/3" },
      { slug: "gone-case", title: "gone-case", url: null },
    ],
  });
});

test("each owner's answer applies only where it fits", async (t) => {
  const directory = dataDirectory(t);
  enroll(directory, "acme/tally", "Omkar");
  const ask = call(directory, "acme/tally", 1, ASK);
  const go = call(directory, "acme/tally", 2, GO);
  const auto = call(directory, "acme/tally", 3, NO, { confirm: false });

  await assert.rejects(confirmCall(directory, ask.id, "Omkar"), /is a question: answer it/u);
  await assert.rejects(overrideCall(directory, ask.id, "Omkar", "go", "x"), /is a question: answer it/u);
  await assert.rejects(answerCall(directory, go.id, "Omkar", "go", "x"), /not a question/u);
  await assert.rejects(confirmCall(directory, auto.id, "Omkar"), /not waiting to be confirmed \(auto\)/u);
  await assert.rejects(overrideCall(directory, go.id, "Omkar", "go", "x"), /already go; confirm it instead/u);
  await assert.rejects(overrideCall(directory, go.id, "Omkar", "no", "  "), (error: OwnerError) => error.status === 400 && /a reason is required/u.test(error.message));
  await assert.rejects(answerCall(directory, ask.id, "Omkar", "maybe", "x"), /the call is go or no/u);
  await assert.rejects(confirmCall(directory, 12345, "Omkar"), (error: OwnerError) => error.status === 404);

  await confirmCall(directory, go.id, "Omkar");
  await assert.rejects(confirmCall(directory, go.id, "Omkar"), /not waiting to be confirmed \(confirmed\)/u);
  // A call entail acted on at once can still be overridden.
  await overrideCall(directory, auto.id, "Omkar", "go", "We want it.");
  await assert.rejects(overrideCall(directory, auto.id, "Omkar", "no", "Changed my mind."), /already the owner's \(overridden\)/u);

  // A call judged again before the owner settled it cannot be settled.
  const newer = call(directory, "acme/tally", 1, ASK);
  await assert.rejects(answerCall(directory, ask.id, "Omkar", "go", "x"), /the issue was edited and entail judged it again/u);
  await answerCall(directory, newer.id, "Omkar", "no", "No.");

  const [view] = repoViews(directory, SETTINGS);
  assert.deepEqual({ calls: view!.calls, waiting: view!.waiting, checked: view!.checked, agreed: view!.agreed }, { calls: 4, waiting: 0, checked: 2, agreed: 1 });
});

test("pending work follows the log: latest calls to post, confirmations, owner's noes, and goes to run again", (t) => {
  const directory = dataDirectory(t);
  enroll(directory, "acme/tally", "Omkar");
  const first = call(directory, "acme/tally", 1, GO);
  const second = call(directory, "acme/tally", 1, NO);
  const ask = call(directory, "acme/tally", 2, ASK);
  appendEntry(directory, "acme/tally", { type: "answered", by: "Omkar", call: ask.id, to: "go", answer: "Yes." });
  assert.deepEqual(
    pendingWork(readLog(directory, "acme/tally")).map((work) => [work.kind, "entry" in work ? work.entry.id : work.call.id]),
    [
      ["call", second.id],
      ["call", ask.id],
      ["rerun", ask.id],
    ],
  );
  assert.notEqual(first.id, second.id);
});

test("the log reads every call and every owner's action with its reason", async (t) => {
  const directory = dataDirectory(t);
  enroll(directory, "acme/tally", "Omkar", {}, new Date("2026-11-12T09:00:00Z"));
  const go = call(directory, "acme/tally", 1, { ...GO, criteria: [{ source: "edge", criterion: "Leave the CLI alone.", basis: "x" }] });
  await overrideCall(directory, go.id, "Omkar", "no", "Not now.", new Date("2026-11-12T12:00:00Z"));
  const text = formatLog(logItems(directory, []), { repoColumn: true });
  assert.match(text, /2026-11-12 09:00 {2}acme\/tally {2}enrolled by Omkar/u);
  assert.match(text, /acme\/tally#1 {2}GO by entail: Issue 1\n {6}Better\.\n {6}criterion \[edge\]: Leave the CLI alone\.\n {6}overridden by Omkar · claude-opus-5-5 at low effort · call \d+/u);
  assert.match(text, /2026-11-12 12:00 {2}acme\/tally#1 {2}OVERRIDDEN by Omkar to no \(call \d+\)\n {6}Not now\./u);
  assert.equal(formatLog([], { repoColumn: false }), "No calls yet.");
});

test("a line half-written by a crash costs only itself", (t) => {
  const directory = dataDirectory(t);
  enroll(directory, "acme/tally", "Omkar");
  appendFileSync(logFile(directory, "acme/tally"), '{"type":"call","id":4');
  call(directory, "acme/tally", 1, GO);
  assert.deepEqual(
    readLog(directory, "acme/tally").map((entry) => entry.type),
    ["enrolled", "call"],
  );
});
