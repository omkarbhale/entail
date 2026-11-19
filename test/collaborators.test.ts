import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { OWNER_CASE_BOOK, readCaseBook, readLandingCaseBook } from "../src/case-book.ts";
import { commentRuleViolations } from "../src/comment-rules.ts";
import { Notifier } from "../src/notices.ts";
import { answerCall, changeRepoSettings, checkSettingsChange, confirmCall, formatLog, formatWaiting, HOLD_MS, itemView, latestCallOn, logItems, OwnerError, repoViews, undoAction, waitingItems } from "../src/owner.ts";
import { readLog, repoState, visionGrowth, type AnsweredEntry, type CallEntry } from "../src/records.ts";
import { VISION_GROWTH_KIND, type VisionGrowthAnswer } from "../src/vision-growth.ts";
import { harness, landingAnswer, OWNER, REPO, verdict, type Harness } from "./watch-fixture.ts";

const SAM = "Sam";

const GENERAL: VisionGrowthAnswer = {
  general: true,
  line: "tally never reads a file the user did not name.",
  heading: "Vision",
  reason: "The answer says tally never reads files beyond the ones named, which holds for every feature that reads input.",
};

const growthRuns = (h: Harness) => h.runner.requests.filter((request) => request.kind === VISION_GROWTH_KIND);

function allow(h: Harness, name = SAM): void {
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { allow: name });
}

/** An issue entail asked about, with the pass that posts the question. */
async function asked(h: Harness, number = 11): Promise<number> {
  h.forge.file(number, "Count words in every file under a directory");
  h.script(number, verdict({ call: "ask", reason: "Reading a whole tree is not what the vision describes.", question: { question: "Should tally walk a directory?", why: "It changes what tally reads." } }));
  await h.pass();
  return latestCallOn(h.dataDirectory, REPO, number);
}

const collaboratorAnswer = (h: Harness, id: number, to: string, words: string, name = SAM) => answerCall(h.dataDirectory, id, name, to, words, new Date(), { collaborator: true });

// The permission: the owner's, per repo, and nothing changes until it is given.

test("a repo with no collaborators set is owner-only, and a collaborator's answer is refused", async (t) => {
  const h = harness(t);
  const id = await asked(h);
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).collaborators, []);
  await assert.rejects(collaboratorAnswer(h, id, "go", "Yes."), (error: unknown) => error instanceof OwnerError && error.status === 403 && /only the owner can allow a collaborator/u.test(error.message));
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "answered").length, 0, "nothing was recorded");
  // The owner's own answer goes as it always did.
  const answered = await answerCall(h.dataDirectory, id, OWNER, "no", "Not now.");
  assert.equal(answered.by, OWNER);
  assert.equal("collaborator" in answered, false);
});

test("the owner allows and removes a collaborator for a repo; each is logged under the owner's name and only a real change is", (t) => {
  const h = harness(t);
  allow(h);
  allow(h, " sam ");
  assert.deepEqual(repoViews(h.dataDirectory, { owner: OWNER, model: "claude-opus-5-5", effort: "low" })[0]!.collaborators, [SAM]);
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { allow: "Priya" });
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { disallow: "SAM" });
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { disallow: SAM });
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).collaborators, ["Priya"]);
  const settings = readLog(h.dataDirectory, REPO).flatMap((entry) => (entry.type === "settings" ? [entry] : []));
  assert.deepEqual(
    settings.map(({ by, allowed, disallowed }) => ({ by, allowed, disallowed })),
    [
      { by: OWNER, allowed: SAM, disallowed: undefined },
      { by: OWNER, allowed: "Priya", disallowed: undefined },
      { by: OWNER, allowed: undefined, disallowed: SAM },
    ],
  );
  const text = formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false });
  assert.match(text, /Omkar allowed Sam to answer board items as a collaborator/u);
  assert.match(text, /Omkar took away Sam's permission to answer board items/u);
});

test("a collaborator cannot be given the owner's own name, and a name is one plain line", (t) => {
  const h = harness(t);
  assert.throws(() => changeRepoSettings(h.dataDirectory, REPO, OWNER, { allow: " omkar " }), (error: unknown) => error instanceof OwnerError && /owner's own name/u.test(error.message));
  for (const bad of ["", "   ", "/close", "#1", "x".repeat(81), 3, null]) assert.throws(() => checkSettingsChange({ allow: bad }), OwnerError, JSON.stringify(bad));
  assert.deepEqual(checkSettingsChange({ allow: "  Sam   Lee ", disallow: "Priya" }), { allow: "Sam Lee", disallow: "Priya" });
  assert.deepEqual(checkSettingsChange({ allow: "Sam\nLee" }), { allow: "Sam Lee" }, "a name never spans lines");
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).collaborators, []);
});

test("a collaborator who was removed can no longer answer", async (t) => {
  const h = harness(t);
  allow(h);
  const id = await asked(h);
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { disallow: SAM });
  await assert.rejects(collaboratorAnswer(h, id, "go", "Yes."), (error: unknown) => error instanceof OwnerError && error.status === 403);
});

test("removing a collaborator voids their answer still held: it settles nothing and they cannot undo it", async (t) => {
  const h = harness(t);
  allow(h);
  const id = await asked(h);
  await answerCall(h.dataDirectory, id, SAM, "no", "No.", new Date(), { holdMs: HOLD_MS, collaborator: true });
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { disallow: SAM });
  const voided = readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "undone");
  assert.equal(voided.length, 1);
  assert.match(voided[0]!.type === "undone" ? voided[0]!.reason ?? "" : "", /Sam is no longer allowed/u);
  assert.throws(() => undoAction(h.dataDirectory, id, SAM, new Date(), { collaborator: true }), (error: unknown) => error instanceof OwnerError && error.status === 409);
  assert.equal(itemView(h.dataDirectory, id, []).status, "waiting");
});

test("removing a collaborator leaves an answer already acted on, and another collaborator's held answer", async (t) => {
  const h = harness(t);
  allow(h);
  allow(h, "Priya");
  const id = await asked(h);
  await answerCall(h.dataDirectory, id, "Priya", "no", "No.", new Date(), { holdMs: HOLD_MS, collaborator: true });
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { disallow: SAM });
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "undone").length, 0);
});

// The answer: the same single path, under the collaborator's name.

test("a collaborator's answer is stored, shown on the board and in the log under their name, never as the owner's", async (t) => {
  const h = harness(t);
  allow(h);
  const id = await asked(h);
  const recorded = await collaboratorAnswer(h, id, "no", "Not this release.", " sam ");
  assert.equal(recorded.by, SAM, "kept under the name the owner allowed");
  assert.equal(recorded.collaborator, true);
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry): entry is AnsweredEntry => entry.type === "answered").length, 1, "the one answer-recording path");

  const view = itemView(h.dataDirectory, id, []);
  assert.equal(view.status, "answered");
  assert.equal(view.settledBy?.by, SAM);
  assert.equal(view.settledBy?.collaborator, true);
  const text = formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false });
  assert.match(text, /ANSWERED by Sam \(a collaborator\): no/u);
  assert.match(text, /answered by Sam \(a collaborator\)/u);
  assert.doesNotMatch(text, /answered by Omkar|ANSWERED by Omkar/u);
});

test("a collaborator's answer is held ten seconds like the owner's, and the collaborator can undo only their own", async (t) => {
  const h = harness(t);
  allow(h);
  allow(h, "Priya");
  const id = await asked(h);
  const now = new Date();
  const action = await answerCall(h.dataDirectory, id, SAM, "no", "No.", now, { holdMs: HOLD_MS, collaborator: true });
  assert.throws(() => undoAction(h.dataDirectory, id, "Priya", now, { collaborator: true }), (error: unknown) => error instanceof OwnerError && error.status === 403);
  const undone = undoAction(h.dataDirectory, id, SAM, now, { collaborator: true });
  assert.equal(undone.undone.id, action.id);
  const again = await answerCall(h.dataDirectory, id, SAM, "no", "No, really.", now, { holdMs: HOLD_MS, collaborator: true });
  // The owner can undo a collaborator's answer; the owner's own is out of a collaborator's reach.
  assert.equal(undoAction(h.dataDirectory, id, OWNER, now).undone.id, again.id);
  const owners = await answerCall(h.dataDirectory, id, OWNER, "go", "Go.", now, { holdMs: HOLD_MS });
  assert.throws(() => undoAction(h.dataDirectory, id, SAM, now, { collaborator: true }), (error: unknown) => error instanceof OwnerError && error.status === 403);
  assert.equal(undoAction(h.dataDirectory, id, OWNER, now).undone.id, owners.id);
});

test("a collaborator's no closes the issue under their name, and is not the owner's word on the issue or in the case book", async (t) => {
  const h = harness(t);
  allow(h);
  const answered = await collaboratorAnswer(h, await asked(h), "no", "Not now; the JavaScript build is fine.");
  await h.pass();
  const body = h.forge.posted[1]!.body;
  assert.match(body, /\*\*No\*\*, on the answer of Sam, a collaborator Omkar allowed to answer on the board\. It is Sam's word, not Omkar's own\.\n\nNot now; the JavaScript build is fine\.\n\nClosing the issue/u);
  assert.doesNotMatch(body, /on Omkar's answer/u);
  assert.deepEqual(h.forge.closed, [11]);
  assert.deepEqual(commentRuleViolations(body, OWNER, answered.id), []);
  assert.equal(existsSync(join(h.dataDirectory, OWNER_CASE_BOOK)), false, "the case book holds the owner's own calls only");
});

test("a collaborator's go runs the judgment again on their word, named as theirs in what it reads and what is posted", async (t) => {
  const h = harness(t);
  allow(h);
  h.forge.file(11, "Word counts are sometimes wrong");
  h.script(
    11,
    verdict({ call: "ask", reason: "Two readings.", question: { question: "Does a non-breaking space separate words?", why: "Counts differ." } }),
    verdict({ reason: "The answer chose: a non-breaking space separates words.", criteria: [{ source: "answer", criterion: "A non-breaking space separates words.", basis: "The answer." }] }),
  );
  await h.pass();
  await collaboratorAnswer(h, latestCallOn(h.dataDirectory, REPO, 11), "go", "Yes: any whitespace a reader sees separates words.");
  assert.equal((await h.pass()).judged, 1);

  const prompt = h.runner.requests[1]!.prompt;
  assert.match(prompt, /\*\*Sam \(a collaborator, on entail's board\)\*\*/u);
  assert.match(prompt, /Sam's answer \(Sam is a collaborator the owner allowed to answer, not the owner\): go\./u);
  assert.doesNotMatch(prompt, /Omkar \(the owner/u);
  assert.doesNotMatch(prompt, /The owner's answer:/u);

  const body = h.forge.posted[1]!.body;
  assert.match(body, /\*\*Go\*\*, on the answer of Sam, a collaborator Omkar allowed to answer on the board\. It is Sam's word, not Omkar's own\./u);
  assert.match(body, /- A non-breaking space separates words\./u, "it settles the ticket the same way: the criteria are posted");
  assert.equal(existsSync(join(h.dataDirectory, OWNER_CASE_BOOK)), false);
  const rerun = readLog(h.dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call")[1]!;
  assert.equal(rerun.trigger, "owner");
  assert.equal(rerun.owner?.collaborator, SAM);
  const text = formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false });
  assert.match(text, /entail, on Sam's answer, a collaborator's, not the owner's/u);
  assert.doesNotMatch(text, /the owner's answer/u);
  assert.deepEqual(waitingItems(h.dataDirectory, []), []);
});

test("the owner's own answers still read and post exactly as before", async (t) => {
  const h = harness(t);
  allow(h);
  await answerCall(h.dataDirectory, await asked(h), OWNER, "no", "Not now.");
  await h.pass();
  assert.match(h.forge.posted[1]!.body, /\*\*No\*\*, on Omkar's answer on the board\.\n\nNot now\./u);
  assert.equal((await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK))).length, 1);
});

// A PR: the same path, and the owner's alone where only the owner can let it merge.

test("a collaborator answers a PR's question, which merges it under their name and stays out of the landing case book", async (t) => {
  const h = harness(t, { confirm: false });
  allow(h);
  const HEAD = "1".repeat(40);
  h.forge.openPull(9, "Drop the --lines flag", { head: HEAD, closes: [] });
  h.forge.report(HEAD, ["test", "passed"]);
  h.scriptLanding(9, landingAnswer({ call: "ask", question: { question: "Drop the --lines flag users rely on?", why: "It removes something users rely on." } }));
  await h.pass();
  const [waiting] = waitingItems(h.dataDirectory, []);
  await collaboratorAnswer(h, waiting!.id, "send-back", "Keep it: tally keeps the flags users rely on.");
  await h.pass();
  const body = h.forge.posted.findLast((post) => post.issue === 9)!.body;
  assert.match(body, /\*\*Send back\*\*, on the answer of Sam, a collaborator Omkar allowed to answer on the board\. It is Sam's word, not Omkar's own\./u);
  assert.equal(existsSync(join(h.dataDirectory, OWNER_CASE_BOOK)) ? (await readLandingCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK))).length : 0, 0);
});

test("a collaborator cannot answer a PR that changes the vision or a pinned path: only the owner lets that merge", async (t) => {
  const h = harness(t, { confirm: false });
  allow(h);
  const HEAD = "2".repeat(40);
  h.forge.file(1, "Read standard input", "tally only reads files.");
  h.script(1, verdict({ criteria: [] }));
  await h.pass();
  h.forge.openPull(9, "Rewrite the vision", { head: HEAD, closes: [1], files: [{ path: "VISION.md", status: "modified", previousPath: null, additions: 3, deletions: 1 }] });
  h.forge.report(HEAD, ["test", "passed"]);
  h.scriptLanding(9, landingAnswer());
  await h.pass();
  const [waiting] = waitingItems(h.dataDirectory, []);
  assert.ok(waiting, "the PR waits as a question for the owner");
  await assert.rejects(collaboratorAnswer(h, waiting!.id, "merge", "Fine."), (error: unknown) => error instanceof OwnerError && error.status === 403 && /only the owner lets merge/u.test(error.message));
  const owners = await answerCall(h.dataDirectory, waiting!.id, OWNER, "merge", "Merge it.");
  assert.equal(owners.by, OWNER);
});

test("confirming a call is the owner's: the confirm path takes no collaborator", async (t) => {
  const h = harness(t);
  allow(h);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();
  const go = readLog(h.dataDirectory, REPO).find((e): e is CallEntry => e.type === "call")!;
  // Whatever name is passed, a confirmation is recorded as the owner's and never carries a collaborator mark.
  const confirmed = await confirmCall(h.dataDirectory, go.id, OWNER);
  assert.equal("collaborator" in confirmed, false);
  assert.equal(formatWaiting(waitingItems(h.dataDirectory, [])).includes("a collaborator"), false);
});

// The vision: recorded as the collaborator's, never as stated by the owner, and the owner is told.

test("a collaborator's answer that enters VISION.md is recorded as theirs and not as stated by the owner, and the owner is told", async (t) => {
  const h = harness(t);
  allow(h);
  h.scriptGrowth(11, GENERAL);
  await collaboratorAnswer(h, await asked(h), "no", "Never read a file the user did not name.");
  await h.pass();

  assert.equal(h.forge.fileCommits.length, 1);
  assert.doesNotMatch(h.forge.visionFile!, /Sam|collaborator|Omkar/u, "VISION.md carries no mark of its origin");
  assert.match(h.forge.fileCommits[0]!.message, /Answered by Sam, a collaborator the owner allowed to answer; not stated by the owner\./u);
  const [added] = visionGrowth(readLog(h.dataDirectory, REPO));
  assert.equal(added!.by, SAM);
  assert.equal(added!.collaborator, true);
  assert.match(growthRuns(h)[0]!.prompt, /Sam, a collaborator the owner allowed to answer \(not the owner\), answered no/u);
  assert.ok(h.printed.some((text) => /added to VISION\.md automatically, from Sam \(a collaborator\)'s answer on acme\/tally#11/u.test(text)));
  assert.match(formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false }), /from Sam \(a collaborator\)'s answer on the board/u);

  const directory = mkdtempSync(join(tmpdir(), "entail-notice-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sent: string[] = [];
  const notifier = new Notifier({ dataDirectory: directory, command: () => "notify", link: "http://127.0.0.1:4380/#/waiting", send: async (_command, line) => (sent.push(line), { ok: true }) });
  await notifier.grown([{ repo: REPO, grown: added! }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], `entail: added to acme/tally's VISION.md from Sam's answer on #11 (a collaborator's, not stated by you): ${GENERAL.line}`);
});

test("the owner's answer that enters VISION.md is recorded and told as before", async (t) => {
  const h = harness(t);
  allow(h);
  h.scriptGrowth(11, GENERAL);
  await answerCall(h.dataDirectory, await asked(h), OWNER, "no", "Never read a file the user did not name.");
  await h.pass();
  const [added] = visionGrowth(readLog(h.dataDirectory, REPO));
  assert.equal(added!.by, OWNER);
  assert.equal("collaborator" in added!, false);
  assert.doesNotMatch(h.forge.fileCommits[0]!.message, /collaborator/u);
  assert.match(growthRuns(h)[0]!.prompt, /Omkar answered no/u);
});
