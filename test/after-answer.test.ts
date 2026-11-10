import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { afterAnswerPlanner, answersInForce, pinsSeen, type AnswerCallDetail } from "../src/after-answer.ts";
import { answerComment, recordBoardAnswer, type ChosenAnswer } from "../src/answer.ts";
import { boardPlanner, type BoardItemSnapshot } from "../src/board-item.ts";
import type { ChallengeOutput } from "../src/challenge.ts";
import { assertCommentRules } from "../src/comment-rules.ts";
import { checkCriteria, criteriaInForce, criteriaPlanner, type CriteriaDetail } from "../src/criteria.ts";
import { deciderPlanner, owesVerdict } from "../src/decider.ts";
import { ForgeLoggedOutError, type CommitChecks } from "../src/forge/forge.ts";
import { CLEARED_LABEL, EXECUTOR_LINE, RAISED_LABEL } from "../src/intake-comment.ts";
import { Mirror } from "../src/mirror.ts";
import type { CriteriaOutput, VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import type { Pin, RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { BoardItemRecord, CallRecord, RepoRecord, TicketRecord } from "../src/store.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { IntakeForge, issue, passSetup, type PassSetup } from "./pass-fixture.ts";

const VISION = `# tally

tally counts the words of text files.

## Rules

tally never reaches the network.
A word is a run of characters between whitespace.
Output is plain text, one count per line.
`;

const ORIGIN = "http://127.0.0.1:7419";
const WORD_LINE = "A word is a run of characters between whitespace.";
const FORMAT_PIN: Pin = { topic: "the output format", paths: ["src/format.js"], keywords: [] };

const R1 = { id: "R1", reading: "Split words on whitespace only.", observed_outcome: "`tally` counts `a-b` as one word." };
const R2 = { id: "R2", reading: "Split words on punctuation too.", observed_outcome: "`tally` counts `a-b` as two words." };

/** A verdict that needs the owner: two consequential readings the vision does not choose between. */
function needsTheOwner(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return {
    size: { value: "fits", reason: "One change to the word splitter." },
    readings: [R1, R2],
    pins_touched: [],
    vision_check: [{ line: WORD_LINE, mark: "does_not_settle" }],
    verdict: "needs_the_owner",
    citations: [],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: "consequential_readings",
    open_readings: ["R1", "R2"],
    questions: [],
    close_evidence: [],
    reason: "Whether punctuation splits words is for the owner.",
    ...fields,
  };
}

/** Criteria written from an answer choosing R2, traced to it. */
function answeredCriteria(...extra: CriteriaOutput["criteria"]): CriteriaOutput {
  return {
    outcome: "criteria",
    criteria: [
      { id: "C1", sentence: "`tally` counts `a-b` as two words.", source: { kind: "answer", ref: null }, checks: [], states_reading: null },
      ...extra,
    ],
    product_call: null,
  };
}

const UPHELD: ChallengeOutput = { outcome: "upheld", objections: [], reason: "Nothing overturns the criteria." };

const PRODUCT_CALL: CriteriaOutput = {
  outcome: "needs_product_call",
  criteria: [],
  product_call: {
    reason: "Whether an apostrophe splits a word is something users see, and the answer does not choose it.",
    options: [
      { reading: "An apostrophe joins a word.", observed_outcome: "`tally` counts `don't` as one word." },
      { reading: "An apostrophe splits a word.", observed_outcome: "`tally` counts `don't` as two words." },
    ],
  },
};

const OPTION_R2: ChosenAnswer = { shape: "option", optionId: "R2", text: null, note: null, showNoteOnIssue: false };
const DONT: ChosenAnswer = { shape: "dont-go-ahead", optionId: null, text: null, note: null, showNoteOnIssue: false };

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

/** A forge whose default branch has recently reported the check `test`. */
class ChecksForge extends IntakeForge {
  override async recentDefaultBranchChecks(): Promise<CommitChecks[]> {
    return [{ sha: "c0ffee", checks: [{ name: "test", status: "passed", reported: true, url: null }] }];
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: ChecksForge;
  scripted: ScriptedRunner;
  engine: Passes;
  pass(times?: number): Promise<void>;
  ticket(): TicketRecord;
  calls(): CallRecord[];
  openItem(): BoardItemRecord;
  /** Records the owner's answer to the ticket's open item, as the board form's final step does. */
  answer(answer: ChosenAnswer): void;
  comments(): string[];
}

async function harness(t: TestContext, options: { pins?: Pin[] } = {}): Promise<Harness> {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const settings = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
  setup.store.saveSettings(repo.id, { ...settings, pins: options.pins ?? [], genericCriteria: [] }, "Ada");
  const fixture = new FixtureRepo(t);
  fixture.write("VISION.md", VISION).write("src/format.js", "export const format = (n) => String(n);\n");
  fixture.commit("vision");
  fixture.push();
  const mirror = await Mirror.open({
    dataDirectory: setup.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: repo.projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  const forge = new ChecksForge();
  const scripted = new ScriptedRunner();
  const notifier = new Notifier({ connectorName: () => "file", connectors: {}, dataDirectory: setup.dataDirectory, log: setup.log });
  const common = { store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory, mirrorFor: async () => mirror };
  const engine = new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: () => forge,
    defaultBranchFor: async () => mirror,
    planners: [
      afterAnswerPlanner({ store: setup.store, log: setup.log }),
      deciderPlanner(common),
      criteriaPlanner(common),
      boardPlanner({ ...common, notifier, boardOrigin: ORIGIN }),
    ],
    modelRuns: new ModelRuns({ runner: scripted, log: setup.log }),
  });
  t.after(() => engine.stop());
  const ticket = () => setup.store.latestTicketForIssue(repo.id, 1)!;
  const h: Harness = {
    setup,
    repo,
    forge,
    scripted,
    engine,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await until(() => engine.stepsRunning === 0, "every step started has finished");
      }
    },
    ticket,
    calls: () => setup.store.callsForTicket(ticket().id),
    openItem: () => setup.store.openBoardItem(ticket().id)!,
    answer(answer) {
      const item = h.openItem();
      const shown = (item.snapshot as BoardItemSnapshot).version;
      const result = recordBoardAnswer(setup.store, { itemId: item.id, shownVersion: shown, answeredBy: "Ada", answer, locked: null });
      assert.ok("recorded" in result, "the answer is recorded");
    },
    comments: () => (forge.state.comments["issue:1"] ?? []).map((c) => c.body),
  };
  return h;
}

/** Takes issue 1 in and runs passes until the verdict raises it to the board. */
async function raised(h: Harness, verdict: VerdictOutput = needsTheOwner()): Promise<BoardItemRecord> {
  h.forge.issues = [issue(1, { title: "Count hyphenated words", body: "Is `a-b` one word or two?" })];
  h.scripted.script("verdict", "1", { output: verdict, facts: { sessionId: "decider-session" } });
  await h.pass(2);
  assert.equal(h.ticket().state, "on-the-board");
  return h.openItem();
}

test("going ahead returns the ticket to deciding only to write criteria: a call citing the answer, and no verdict run again", async (t) => {
  const h = await harness(t);
  const item = await raised(h);
  h.answer(OPTION_R2);
  const answer = h.setup.store.answerFor(item.id)!;
  assert.equal(h.calls().filter((c) => c.answerId !== null).length, 0, "the answer itself is not a call");

  // A model halt: the answer still moves the ticket, and writing the criteria waits.
  h.scripted.script("criteria", "1", { failure: { kind: "usage-limit", message: "usage limit reached" } }, { output: answeredCriteria() });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.engine.runPass();
  await until(() => h.setup.logLines().some((line) => line.event === "usage-limit-pause"), "model work pauses on the usage limit");

  const goAhead = h.calls().find((c) => c.kind === "go-ahead")!;
  assert.equal(goAhead.answerId, answer.id, "the change the answer causes is a call that cites it");
  assert.deepEqual(goAhead.stateChange, { from: "on-the-board", to: "deciding" });
  assert.match(goAhead.reason, /^The owner's answer goes ahead: “Split words on punctuation too\.”/);
  const verdictCall = h.calls().find((c) => c.kind === "verdict")!;
  assert.equal((goAhead.detail as AnswerCallDetail).verdictCallId, verdictCall.id);
  assert.equal(h.ticket().state, "deciding");
  assert.equal(owesVerdict(h.ticket(), h.calls()), false, "the verdict is not run again");
  assert.equal(h.calls().some((c) => c.kind === "criteria"), false, "criteria wait for the halt to clear");

  t.mock.timers.tick(30 * 60_000);
  await until(() => h.engine.stepsRunning === 0, "the criteria step has finished");
  t.mock.timers.reset();
  assert.equal(h.ticket().state, "cleared");
  assert.deepEqual(
    h.scripted.requests.map((r) => r.kind),
    ["verdict", "criteria", "criteria", "challenge"],
    "one verdict only: going ahead writes criteria and runs the challenge",
  );
});

test("criteria written from an answer cite it, pass the usual checks and challenge, and clear the ticket with a comment quoting the decision", async (t) => {
  const h = await harness(t);
  const item = await raised(h);
  h.answer({ ...OPTION_R2, note: "Hyphens are common in our docs.", showNoteOnIssue: true });
  h.scripted.script("criteria", "1", { output: answeredCriteria() });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(2);

  assert.equal(h.ticket().state, "cleared");
  const answer = h.setup.store.answerFor(item.id)!;
  const criteria = h.calls().findLast((c) => c.kind === "criteria")!;
  assert.equal(criteria.answerId, answer.id, "the clear cites the answer");
  assert.equal(criteria.citation, null);
  assert.equal(criteria.noContradictionFound, false);
  assert.deepEqual(criteria.stateChange, { from: "deciding", to: "cleared" });
  assert.match(criteria.reason, /^Cleared on the owner's answer: “Split words on punctuation too\.”/);
  const detail = criteria.detail as CriteriaDetail;
  assert.deepEqual(detail.answerIds, [answer.id]);
  assert.equal(detail.verdict, "needs_the_owner");
  assert.deepEqual(detail.fences, [], "an answered ticket is not fenced");
  assert.deepEqual(criteriaInForce(h.calls())!.criteria.map((c) => c.source.kind), ["answer"]);

  const [criteriaRun, challengeRun] = h.scripted.requests.filter((r) => r.kind === "criteria" || r.kind === "challenge");
  assert.match(criteriaRun!.prompt, /The owner's answers below settle what was raised, and the verdict is not run again\./);
  assert.match(criteriaRun!.prompt, /## The owner's answers \(the owner's word, given on entail's board, oldest first, as JSON\)/);
  assert.match(criteriaRun!.prompt, /"answer": "Split words on punctuation too\."/);
  assert.match(criteriaRun!.prompt, /"note": "Hyphens are common in our docs\."/, "a note shown on the issue is the owner's word too");
  assert.match(criteriaRun!.prompt, /or "answer" \(ref null\) for what the owner's answers decide/);
  assert.match(challengeRun!.prompt, /criteria a PR for the issue must meet were then written from the owner's answers/);
  assert.match(challengeRun!.prompt, /## The owner's answers/);
  assert.match(challengeRun!.prompt, /Your job is to overturn those criteria if you can/);

  const bodies = h.comments();
  assert.equal(bodies.length, 2, "the raise's intake comment, then the new one");
  const body = bodies[1]!;
  assertCommentRules(body, "Ada", h.ticket().id);
  const snapshot = item.snapshot as BoardItemSnapshot;
  const replaced = h.calls().find((c) => c.kind === "raise")!.postedComments[0]!.commentUrl;
  assert.ok(body.startsWith(`Speaking from Ada's entail:\n\nThis replaces [entail's earlier intake comment](${replaced}).\n\n### Vision check`), "it names the comment it replaces");
  assert.match(body, /### What happens next\n\nAda decided:\n\n> Split words on punctuation too\.\n\nWhat a user would observe: `tally` counts `a-b` as two words\./);
  assert.match(body, /A note from Ada:\n\n> Hyphens are common in our docs\./);
  assert.match(body, /- \*\*C1\*\* `tally` counts `a-b` as two words\./);
  assert.match(body, /#### Why cleared\n\nThe owner decided this issue on entail's board, as quoted above, and the criteria cite that decision\. The verdict was not run again\./);
  assert.ok(body.includes(EXECUTOR_LINE));
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL]);
  assert.equal(
    body,
    answerComment("Ada", h.ticket().id, answer, snapshot, "github", {
      next: body.slice(body.indexOf("entail cleared this issue."), body.indexOf(`\n\n${EXECUTOR_LINE}`)),
      replaces: replaced,
    }),
    "the comment is the one the board's receipt showed, with the criteria in place",
  );
});

test("entail:raised marks the issue while its ticket waits on the board, and going ahead takes it off before entail:cleared goes on", async (t) => {
  const h = await harness(t);
  const item = await raised(h);
  assert.deepEqual(h.forge.state.labels[1], [RAISED_LABEL], "raised: the issue carries entail:raised and no other entail: label");
  const raise = h.calls().find((c) => c.kind === "raise")!;
  assert.deepEqual(
    h.setup.store.forgeWritesForCall(raise.id).filter((w) => w.kind === "label").map((w) => w.payload),
    [{ action: "add", label: RAISED_LABEL }],
    "the label is recorded with the raise call",
  );

  h.answer(OPTION_R2);
  h.scripted.script("criteria", "1", { output: answeredCriteria() });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(1);
  assert.equal(h.ticket().state, "deciding");
  assert.deepEqual(h.forge.state.labels[1], [], "answered: entail:raised comes off as the ticket leaves the board, while its criteria are written");
  const goAhead = h.calls().find((c) => c.kind === "go-ahead")!;
  const writes = h.setup.store.forgeWritesForCall(goAhead.id);
  assert.deepEqual(
    writes.map((w) => [w.kind, w.payload]),
    [["label", { action: "remove", label: RAISED_LABEL }]],
    "the removal is recorded with the call that cites the answer",
  );
  assert.ok(!h.setup.store.unconfirmedForgeWrites().some((w) => w.id === writes[0]!.id), "and confirmed");
  assert.equal(h.setup.store.answerFor(item.id)!.boardItemId, item.id);

  await h.pass(1);
  assert.equal(h.ticket().state, "cleared");
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL], "cleared: entail:cleared replaces entail:raised, never beside it");
});

test("\"don't go ahead\" takes entail:raised off the issue it closes", async (t) => {
  const h = await harness(t);
  await raised(h);
  assert.deepEqual(h.forge.state.labels[1], [RAISED_LABEL]);
  h.answer(DONT);
  await h.pass(1);
  assert.equal(h.ticket().state, "cancelled");
  assert.deepEqual(h.forge.state.labels[1], [], "no entail: label is left on a cancelled ticket's issue");
  assert.deepEqual(h.forge.state.sends, { comment: 2, addLabel: 1, removeLabel: 1, close: 1, merge: 0 });
});

test("entail:raised only marks state: adding or removing it by hand answers nothing and moves nothing", async (t) => {
  const h = await harness(t);
  const item = await raised(h);
  const calls = h.calls().length;
  const comments = h.comments().length;
  assert.ok(!h.comments().at(-1)!.includes(RAISED_LABEL), "the intake comment carries no question in the label's name, nor the label");

  // Someone takes the label off by hand.
  h.forge.state.labels[1] = [];
  h.forge.issues = [{ ...h.forge.issues[0]!, labels: [], updatedAt: "2026-11-08T13:00:00.000Z" }];
  await h.pass(2);
  assert.equal(h.ticket().state, "on-the-board", "removing the label is no answer");
  assert.equal(h.openItem().id, item.id, "the item stays open on the board");
  assert.equal(h.setup.store.answerFor(item.id), null);
  assert.equal(h.calls().length, calls, "no call is made");

  // And puts it back, or adds it again, by hand.
  h.forge.state.labels[1] = [RAISED_LABEL];
  h.forge.issues = [{ ...h.forge.issues[0]!, labels: [RAISED_LABEL], updatedAt: "2026-11-08T13:05:00.000Z" }];
  await h.pass(2);
  assert.equal(h.ticket().state, "on-the-board");
  assert.equal(h.setup.store.answerFor(item.id), null, "adding it is no answer either");
  assert.equal(h.calls().length, calls);
  assert.equal(h.comments().length, comments, "nothing is posted");
  assert.deepEqual(h.forge.state.sends.addLabel, 1, "entail does not react to the label: it added it once, on the raise");
  assert.equal(h.forge.state.sends.removeLabel, 0);
});

test("a private note never appears on the forge, nor in what the criteria are written from", async (t) => {
  const h = await harness(t);
  await raised(h);
  h.answer({ shape: "own-words", optionId: null, text: "Count `a-b` as two words.", note: "Secret: a customer asked.", showNoteOnIssue: false });
  h.scripted.script("criteria", "1", { output: answeredCriteria() });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(2);

  assert.equal(h.ticket().state, "cleared");
  const body = h.comments().at(-1)!;
  assert.match(body, /Ada decided:\n\n> Count `a-b` as two words\./, "the owner's own words are quoted");
  for (const text of [...h.comments(), ...h.scripted.requests.map((r) => r.prompt)]) assert.ok(!text.includes("Secret"), "the private note stays in entail's records");
  assert.equal(h.setup.store.answerFor(h.setup.store.boardItemsForTicket(h.ticket().id)[0]!.item.id)!.note, "Secret: a customer asked.");
});

test("\"don't go ahead\" cancels the ticket, comments and closes the issue as not planned, with a call citing the answer", async (t) => {
  const h = await harness(t);
  const item = await raised(h);
  h.answer({ ...DONT, note: "Not for this release.", showNoteOnIssue: false });
  await h.pass(1);

  const answer = h.setup.store.answerFor(item.id)!;
  assert.equal(h.ticket().state, "cancelled");
  const cancel = h.calls().at(-1)!;
  assert.equal(cancel.kind, "cancel-on-answer");
  assert.equal(cancel.answerId, answer.id);
  assert.deepEqual(cancel.stateChange, { from: "on-the-board", to: "cancelled" });
  assert.equal(cancel.postedComments.length, 1);
  const body = h.comments().at(-1)!;
  assert.equal(body, answerComment("Ada", h.ticket().id, answer, item.snapshot as BoardItemSnapshot, "github"), "the comment the receipt showed");
  assert.match(body, /Ada decided not to go ahead with this issue, so entail closes it as not planned/);
  assert.ok(!body.includes("Not for this release"), "a private note never appears on the forge");
  assert.equal(h.forge.state.closed[1], "not-planned");
  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"], "nothing more is run");

  await h.pass(2);
  assert.equal(h.forge.state.sends.comment, 2, "the raise's comment and this one, once each");
  assert.equal(h.forge.state.sends.close, 1);
});

test("a product call the answer does not cover raises a new item for that call alone, and its answer clears the ticket citing both", async (t) => {
  const h = await harness(t);
  const first = await raised(h);
  h.answer(OPTION_R2);
  h.scripted.script("criteria", "1", { output: PRODUCT_CALL }, { output: answeredCriteria() });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(3);

  assert.equal(h.ticket().state, "on-the-board");
  const second = h.openItem();
  assert.notEqual(second.id, first.id);
  assert.equal(second.whyRaised, "criteria_product_call");
  const snapshot = second.snapshot as BoardItemSnapshot;
  assert.deepEqual(
    snapshot.form.options.map((o) => o.reading),
    PRODUCT_CALL.product_call!.options.map((o) => o.reading),
    "only the open call, never the readings the owner already chose between",
  );
  const productCall = h.calls().findLast((c) => c.kind === "criteria")!;
  assert.equal(productCall.answerId, h.setup.store.answerFor(first.id)!.id, "the criteria call cites the answer it was written from");
  assert.equal(h.scripted.requests.filter((r) => r.kind === "verdict").length, 1);

  h.answer({ shape: "option", optionId: "R1", text: null, note: null, showNoteOnIssue: false });
  await h.pass(2);
  assert.equal(h.ticket().state, "cleared");
  const answers = answersInForce(h.setup.store, h.ticket().id);
  assert.deepEqual(answers.map((a) => a.answer.boardItemId), [first.id, second.id]);
  const clear = h.calls().findLast((c) => c.kind === "criteria")!;
  assert.equal(clear.answerId, answers[1]!.answer.id, "the clear cites the latest answer");
  assert.deepEqual((clear.detail as CriteriaDetail).answerIds, answers.map((a) => a.answer.id));
  const criteriaRun = h.scripted.requests.findLast((r) => r.kind === "criteria")!;
  assert.match(criteriaRun.prompt, /"answer": "Split words on punctuation too\."[\s\S]*"answer": "An apostrophe joins a word\."/, "both answers, oldest first");

  const body = h.comments().at(-1)!;
  assert.match(body, /Ada decided:\n\n> Split words on punctuation too\.[\s\S]*Ada decided:\n\n> An apostrophe joins a word\./, "every decision in force is quoted, oldest first");
});

test("an item raised for a pin, once answered, counts as the owner having seen that pin for the ticket", async (t) => {
  const h = await harness(t, { pins: [FORMAT_PIN] });
  const item = await raised(
    h,
    needsTheOwner({ why_raised: "pin", open_readings: ["R2"], pins_touched: [{ pin: "the output format", why: "two counts change what is printed" }] }),
  );
  assert.deepEqual((item.snapshot as BoardItemSnapshot).why.pins.map((p) => p.pin), ["the output format"]);
  assert.deepEqual(pinsSeen(h.setup.store, h.ticket().id), [], "an open item is not yet seen");

  h.answer({ shape: "option", optionId: "R2", text: null, note: null, showNoteOnIssue: false });
  assert.deepEqual(pinsSeen(h.setup.store, h.ticket().id), ["the output format"]);
  h.scripted.script("criteria", "1", { output: answeredCriteria() });
  h.scripted.script("challenge", "1", {
    output: {
      outcome: "overturned",
      objections: [{ kind: "touched_pin", objection: "Two counts change the output format.", lines: [], pin: "the output format", reading: null, criterion: null }],
      reason: "It touches the output format.",
    },
  });
  await h.pass(2);

  assert.equal(h.ticket().state, "cleared", "the seen pin does not raise the ticket again");
  const goAhead = h.calls().find((c) => c.kind === "go-ahead")!;
  assert.deepEqual((goAhead.detail as AnswerCallDetail).pinsSeen, ["the output format"]);
  const clear = h.calls().findLast((c) => c.kind === "criteria")!;
  const challenge = clear.challenge as { overturned: boolean; set_aside: { pin: string }[] };
  assert.equal(challenge.overturned, false);
  assert.deepEqual(challenge.set_aside.map((o) => o.pin), ["the output format"], "what was set aside stays on the record");
  const challengeRun = h.scripted.requests.find((r) => r.kind === "challenge")!;
  assert.match(challengeRun.prompt, /The owner has seen these pins for this ticket, so they are no objection: "the output format"\./);
});

test("a pin the owner has not seen still raises the ticket after an answer, and the new item names only it", async (t) => {
  const docs: Pin = { topic: "the docs", paths: ["docs/**"], keywords: [] };
  const h = await harness(t, { pins: [FORMAT_PIN, docs] });
  await raised(h, needsTheOwner({ why_raised: "pin", open_readings: ["R2"], pins_touched: [{ pin: "the output format", why: "two counts" }] }));
  h.answer({ shape: "option", optionId: "R2", text: null, note: null, showNoteOnIssue: false });
  h.scripted.script("criteria", "1", { output: answeredCriteria() });
  h.scripted.script("challenge", "1", {
    output: {
      outcome: "overturned",
      objections: [
        { kind: "touched_pin", objection: "It changes the output format.", lines: [], pin: "the output format", reading: null, criterion: null },
        { kind: "touched_pin", objection: "The docs describe word splitting.", lines: [], pin: "the docs", reading: null, criterion: null },
      ],
      reason: "It touches pins.",
    },
  });
  await h.pass(3);

  assert.equal(h.ticket().state, "on-the-board");
  const snapshot = h.openItem().snapshot as BoardItemSnapshot;
  assert.deepEqual(snapshot.why.pins.map((p) => p.pin), ["the docs"], "the seen pin is not named again");
  assert.deepEqual(snapshot.form.options, [], "the readings the owner chose between are not offered again");
});

test("an answer recorded just before a host halt is acted on when the host is back, its comment posted then", async (t) => {
  const h = await harness(t);
  await raised(h);
  h.answer(DONT);
  h.forge.failChanges = new ForgeLoggedOutError("github.com", "gh is logged out");
  await h.pass(1);
  assert.equal(h.engine.hostHalted("github.com"), true);
  assert.equal(h.ticket().state, "on-the-board", "nothing reaches a halted host");
  assert.equal(h.forge.state.sends.close, 0);

  await h.pass(1);
  assert.equal(h.engine.hostHalted("github.com"), false);
  assert.equal(h.ticket().state, "cancelled");
  assert.match(h.comments().at(-1)!, /decided not to go ahead/);
  assert.equal(h.forge.state.closed[1], "not-planned");
});

test("an answer that goes ahead is checked like any criteria: invalid sources are a machine failure", () => {
  const output: CriteriaOutput = answeredCriteria();
  const base = { verdict: needsTheOwner() as never, visionLines: [], fences: [], findings: null, seenChecks: [] };
  assert.equal(checkCriteria(output, { ...base, answered: true }).passed, true);
  assert.equal(checkCriteria(output, { ...base, answered: false }).passed, false, "no answer, no answer source");
  const stating = answeredCriteria({ id: "C2", sentence: "Words split on punctuation.", source: { kind: "issue", ref: null }, checks: [], states_reading: "R2" });
  const checks = checkCriteria(stating, { ...base, answered: true });
  assert.equal(checks.passed, false);
  assert.match(checks.results.find((r) => !r.passed)!.failure!, /goes ahead on the owner's answer, so no criterion states a reading entail chose/);
});
