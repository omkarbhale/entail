import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import {
  BOARD_ITEM_PARTS,
  BOARD_ITEM_VERSION,
  boardItemLink,
  boardPlanner,
  owedRaise,
  raiseFromVerdict,
  raiseToBoard,
  ticketHistoryLink,
  type BoardItemSnapshot,
} from "../src/board-item.ts";
import { assertCommentRules } from "../src/comment-rules.ts";
import { deciderPlanner } from "../src/decider.ts";
import { settleUnconfirmedWrites } from "../src/forge-writer.ts";
import { EXECUTOR_LINE } from "../src/intake-comment.ts";
import { Mirror } from "../src/mirror.ts";
import type { VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier, NOTICES_FILE, type NoticeConnector } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import type { Pin, RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { actor, comment, IntakeForge, issue, passSetup, type PassSetup } from "./pass-fixture.ts";

const VISION = `# tally

tally counts the words of text files.

## Rules

tally never reaches the network.
A word is a run of characters between whitespace.
`;

const ORIGIN = "http://127.0.0.1:7419";
const FORMAT_PIN: Pin = { topic: "the output format", paths: ["src/format.js"], keywords: [] };

const T7 = {
  title: "Count the words of a web page given its URL",
  body: "tally https://example.com should fetch the page and count its words.",
};

/** A needs-the-owner verdict, with every field the schema asks for. */
function needsTheOwner(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return {
    size: { value: "fits", reason: "One flag." },
    readings: [{ id: "R1", reading: "Fetch the page at the URL.", observed_outcome: "`tally https://example.com` prints the page's word count." }],
    pins_touched: [],
    vision_check: [
      { line: "tally never reaches the network.", mark: "contradicts" },
      { line: "tally counts the words of text files.", mark: "does_not_settle" },
    ],
    verdict: "needs_the_owner",
    citations: [],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: "contradiction",
    open_readings: ["R1"],
    close_evidence: [],
    questions: [],
    reason: "Fetching a URL contradicts the network line.",
    ...fields,
  };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: IntakeForge;
  scripted: ScriptedRunner;
  notifier: Notifier;
  mirror: Mirror;
  visionSha: string;
  pass(): Promise<void>;
  ticket(issueNumber: number): TicketRecord;
  notices(): Record<string, unknown>[];
}

async function harness(t: TestContext, options: { pins?: Pin[]; connector?: NoticeConnector } = {}): Promise<Harness> {
  const setup = passSetup(t);
  const repo = setup.enroll();
  if (options.pins) {
    const settings = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
    setup.store.saveSettings(repo.id, { ...settings, pins: options.pins }, "Ada");
  }
  const fixture = new FixtureRepo(t);
  fixture.write("VISION.md", VISION).write("src/format.js", "export const format = (n) => String(n);\n");
  const visionSha = fixture.commit("vision");
  fixture.push();
  const mirror = await Mirror.open({
    dataDirectory: setup.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: repo.projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  const forge = new IntakeForge();
  const scripted = new ScriptedRunner();
  const notifier = new Notifier({
    connectorName: () => "file",
    connectors: options.connector ? { file: options.connector } : {},
    dataDirectory: setup.dataDirectory,
    log: setup.log,
  });
  const common = { store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory, mirrorFor: async () => mirror };
  const engine = new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: () => forge,
    defaultBranchFor: async () => mirror,
    planners: [deciderPlanner(common), boardPlanner({ ...common, notifier, boardOrigin: ORIGIN })],
    modelRuns: new ModelRuns({ runner: scripted, log: setup.log }),
  });
  t.after(() => engine.stop());
  return {
    setup,
    repo,
    forge,
    scripted,
    notifier,
    mirror,
    visionSha,
    async pass() {
      await engine.runPass();
      await until(() => engine.stepsRunning === 0, "every step started has finished");
    },
    ticket: (issueNumber) => setup.store.latestTicketForIssue(repo.id, issueNumber)!,
    notices() {
      const path = join(setup.dataDirectory, NOTICES_FILE);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** Takes an issue in, records its verdict on the first pass and raises it on the second. */
async function raised(h: Harness, number: number, output: VerdictOutput, fields: Partial<Parameters<typeof issue>[1]> = {}): Promise<TicketRecord> {
  h.forge.issues = [...h.forge.issues, issue(number, fields)];
  // Each harness takes in its issues one at a time, so the next ticket's id is one more than the last.
  h.scripted.script("verdict", String(h.forge.issues.length), { output });
  await h.pass();
  await h.pass();
  return h.ticket(number);
}

const permalink = (sha: string, line: number) => `https://github.com/acme/tally/blob/${sha}/VISION.md#L${line}`;

test("a needs-the-owner verdict creates exactly one open board item, one intake comment and one notice", async (t) => {
  const h = await harness(t);
  h.forge.issueComments.set(7, [comment(70, 7, actor(2002), "Please, I need this.")]);
  const ticket = await raised(h, 7, needsTheOwner(), T7);

  assert.equal(ticket.state, "on-the-board");
  const calls = h.setup.store.callsForTicket(ticket.id);
  assert.deepEqual(calls.map((c) => c.kind), ["intake", "verdict", "raise"]);
  const raise = calls.at(-1)!;
  assert.deepEqual(raise.stateChange, { from: "deciding", to: "on-the-board" });
  assert.equal(raise.inputs?.visionSha, h.visionSha, "the raise records the inputs its verdict judged");
  assert.equal(raise.inputs?.issueTitle, T7.title);

  const items = h.setup.store.boardItemsForTicket(ticket.id);
  assert.equal(items.length, 1, "one board item");
  const item = h.setup.store.openBoardItem(ticket.id)!;
  assert.equal(item.id, items[0]!.item.id, "and it is open");
  assert.equal(item.callId, raise.id);
  assert.equal(item.whyRaised, "contradiction");
  assert.equal(item.decision, "Go ahead with issue #7, although it contradicts the vision line “tally never reaches the network.”?");

  const posted = h.forge.state.comments["issue:7"] ?? [];
  assert.equal(posted.length, 1, "one intake comment");
  assert.equal(raise.postedComments.length, 1, "the comment is recorded on the raise call");
  assert.deepEqual(h.forge.state.sends, { comment: 1, addLabel: 1, removeLabel: 0, close: 0, merge: 0 }, "one label on the board");
  assert.deepEqual(h.forge.state.labels[7], ["entail:raised"], "the issue is labelled entail:raised while its ticket waits on the board");

  assert.equal(boardItemLink(ORIGIN, item.id), `${ORIGIN}/?item=${item.id}`, "the item, on the board at the server's root");
  const notices = h.notices();
  assert.equal(notices.length, 1, "one notice");
  assert.deepEqual(
    { kind: notices[0]!.kind, repo: notices[0]!.repo, link: notices[0]!.link },
    { kind: "board-item", repo: "acme/tally", link: boardItemLink(ORIGIN, item.id) },
  );

  await h.pass();
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 1, "a raised ticket is not raised again");
  assert.equal(h.forge.state.sends.comment, 1);
  assert.equal(h.notices().length, 1);
  assert.equal(h.scripted.requests.length, 1, "and its verdict is not run again");
});

test("the intake comment quotes whole bearing lines with permalinks at the vision sha, links the board, and ends with the executor line", async (t) => {
  const h = await harness(t);
  const ticket = await raised(h, 7, needsTheOwner(), T7);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  const body = h.forge.state.comments["issue:7"]![0]!.body;
  assertCommentRules(body, "Ada", ticket.id);

  const short = h.visionSha.slice(0, 7);
  const visionAt = body.indexOf("### Vision check");
  const nextAt = body.indexOf("### What happens next");
  assert.ok(visionAt > 0 && nextAt > visionAt, "two sections: the vision check, then what happens next");
  assert.match(body, new RegExp(`Only the lines of VISION\\.md that bear on this issue are listed, quoted from VISION\\.md at \`${short}\`\\.`));
  assert.ok(body.includes(`\n> tally never reaches the network.\n\nContradicts · [VISION.md line 7 at \`${short}\`](${permalink(h.visionSha, 7)})`));
  assert.ok(body.includes(`\n> tally counts the words of text files.\n\nDoes not settle · [VISION.md line 3 at \`${short}\`](${permalink(h.visionSha, 3)})`));
  assert.doesNotMatch(body, /A word is a run of characters/, "a line that does not bear is left out");

  const next = body.slice(nextAt);
  assert.ok(next.includes(`raised this issue to the owner, who decides it on [entail's board](${boardItemLink(ORIGIN, item.id)})`));
  const lines = body.trimEnd().split("\n");
  assert.equal(lines.at(-1), `<!-- entail ticket ${ticket.id} -->`);
  assert.equal(lines.at(-3), EXECUTOR_LINE, "the section ends with the one fixed executor line");
  assert.equal(body.split(EXECUTOR_LINE).length, 2, "once");
});

test("neither the comment nor the notice carries question text or issue text", async (t) => {
  const h = await harness(t);
  const ticket = await raised(h, 7, needsTheOwner(), T7);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  const body = h.forge.state.comments["issue:7"]![0]!.body;
  const notice = JSON.stringify(h.notices()[0]);
  for (const [name, text] of [["comment", body], ["notice", notice]] as const) {
    assert.ok(!text.includes(item.decision), `the ${name} has no question text`);
    assert.ok(!text.includes(T7.title) && !text.includes("example.com") && !text.includes("Fetch the page"), `the ${name} has no issue text`);
  }
  assert.deepEqual(Object.keys(h.notices()[0]!).sort(), ["kind", "link", "repo", "text", "time"]);
});

test("the board item stores its parts in the order spec §13 lists, with a version number", async (t) => {
  const h = await harness(t);
  h.forge.issueComments.set(7, [comment(70, 7, actor(2002), "Please, I need this.")]);
  const ticket = await raised(h, 7, needsTheOwner(), T7);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  const snapshot = item.snapshot as BoardItemSnapshot;

  assert.deepEqual(Object.keys(snapshot), ["version", ...BOARD_ITEM_PARTS]);
  assert.equal(snapshot.version, BOARD_ITEM_VERSION);
  assert.equal(snapshot.decision, item.decision);

  assert.equal(snapshot.why.kind, "contradiction");
  assert.equal(snapshot.why.tag, "contradicts a line");
  assert.deepEqual(snapshot.why.contradicted, ["tally never reaches the network."]);
  assert.match(snapshot.why.text, /contradicts the vision line “tally never reaches the network\.”/);

  assert.equal(snapshot.visionCheck.commit, h.visionSha);
  assert.deepEqual(
    snapshot.visionCheck.lines.map((l) => [l.text, l.mark, l.lineNumber, l.heading, l.permalink]),
    [
      ["tally never reaches the network.", "contradicts", 7, "Rules", permalink(h.visionSha, 7)],
      ["tally counts the words of text files.", "does_not_settle", 3, "tally", permalink(h.visionSha, 3)],
    ],
  );

  assert.deepEqual(snapshot.ticket.issue, { number: 7, title: T7.title, url: "https://github.com/acme/tally/issues/7" });
  assert.deepEqual(snapshot.ticket.filedBy, actor(1001), "who filed it");
  assert.equal(snapshot.ticket.request, T7.body, "its text, quoted as the reporter's request");

  assert.deepEqual(snapshot.happened.calls.map((c) => c.kind), ["raise", "verdict", "intake"], "the calls so far, newest first");
  assert.equal(snapshot.happened.historyLink, ticketHistoryLink(ORIGIN, ticket.id));

  assert.deepEqual(snapshot.form.options, [
    {
      id: "R1",
      title: "Go ahead as read",
      reading: "Fetch the page at the URL.",
      outcome: "`tally https://example.com` prints the page's word count.",
      againstVisionLine: true,
    },
  ]);
});

test("consequential readings offer each open reading with its outcome", async (t) => {
  const h = await harness(t);
  const readings = [
    { id: "R1", reading: "Any Unicode whitespace separates words.", observed_outcome: "“new york” counts as 2 words." },
    { id: "R2", reading: "Only ASCII whitespace separates words.", observed_outcome: "“new york” counts as 1 word." },
    { id: "R3", reading: "Not a defensible reading.", observed_outcome: "Nothing." },
  ];
  const ticket = await raised(
    h,
    13,
    needsTheOwner({
      readings,
      vision_check: [{ line: "A word is a run of characters between whitespace.", mark: "does_not_settle" }],
      why_raised: "consequential_readings",
      open_readings: ["R1", "R2"],
    }),
  );
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.decision, "Which reading of issue #13 should go ahead?");
  assert.equal(snapshot.why.tag, "consequential readings");
  assert.deepEqual(
    snapshot.form.options.map((o) => [o.id, o.title, o.outcome, o.againstVisionLine]),
    [
      ["R1", readings[0]!.reading, readings[0]!.observed_outcome, false],
      ["R2", readings[1]!.reading, readings[1]!.observed_outcome, false],
    ],
  );
});

test("a touched pin is named, whether the model judged it touched or entail's path matching found it", async (t) => {
  const h = await harness(t, { pins: [FORMAT_PIN] });
  const ticket = await raised(
    h,
    9,
    needsTheOwner({
      vision_check: [],
      why_raised: "pin",
      open_readings: [],
      readings: [{ id: "R1", reading: "Rename only.", observed_outcome: "The printed output is unchanged." }],
    }),
    { title: "Rename variables in src/format.js for readability" },
  );
  const item = h.setup.store.openBoardItem(ticket.id)!;
  const snapshot = item.snapshot as BoardItemSnapshot;
  assert.equal(item.whyRaised, "pin");
  assert.equal(item.decision, "Go ahead with issue #9, which touches the pin “the output format”?");
  assert.equal(snapshot.why.tag, "pin: the output format");
  assert.deepEqual(snapshot.why.pins, [{ pin: "the output format", why: "the issue names src/format.js, which its path src/format.js matches" }]);
  assert.equal(snapshot.form.options[0]!.title, "Go ahead as read");

  const body = h.forge.state.comments["issue:9"]![0]!.body;
  assert.match(body, /No line of VISION\.md at `[0-9a-f]{7}` bears on this issue\./, "the check says that no line bears");
  assert.doesNotMatch(body, /Only the lines/);
});

test("when the only quoted line is not in VISION.md the check does not claim that no line bears", async (t) => {
  const h = await harness(t);
  await raised(h, 8, needsTheOwner({ vision_check: [{ line: "tally never talks to the internet.", mark: "contradicts" }] }));
  const body = h.forge.state.comments["issue:8"]![0]!.body;
  assert.match(body, /could not be found word for word in VISION\.md/);
  assert.doesNotMatch(body, /No line of VISION\.md/);
  assert.doesNotMatch(body, /talks to the internet/);
});

test("a quoted line that is not word for word in VISION.md is left out of the check and kept on the call", async (t) => {
  const h = await harness(t);
  const ticket = await raised(
    h,
    7,
    needsTheOwner({
      vision_check: [
        { line: "tally never reaches the network.", mark: "contradicts" },
        { line: "tally never talks to the internet.", mark: "contradicts" },
      ],
    }),
  );
  const raise = h.setup.store.callsForTicket(ticket.id).at(-1)!;
  assert.deepEqual((raise.detail as { unquotable: unknown }).unquotable, [{ line: "tally never talks to the internet.", mark: "contradicts" }]);
  const body = h.forge.state.comments["issue:7"]![0]!.body;
  assert.doesNotMatch(body, /talks to the internet/);
  assert.match(body, /Lines the decider quoted could not be found word for word in VISION\.md at `[0-9a-f]{7}`, so they are not quoted\./);
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.visionCheck.lines.length, 1);
  assert.match(snapshot.why.text, /also quoted “tally never talks to the internet\.”, which is not word for word in VISION\.md/);
});

test("a failed notice is logged and blocks nothing", async (t) => {
  const failing: NoticeConnector = {
    name: "file",
    send: async () => {
      throw new Error("no desktop here");
    },
  };
  const h = await harness(t, { connector: failing });
  const ticket = await raised(h, 7, needsTheOwner(), T7);
  assert.equal(ticket.state, "on-the-board");
  assert.notEqual(h.setup.store.openBoardItem(ticket.id), null);
  assert.equal(h.forge.state.sends.comment, 1, "the comment is posted all the same");
  assert.equal(h.notifier.lastFailure?.kind, "board-item");
  assert.ok(h.setup.logLines().some((line) => line.event === "notice-failed"));
});

test("a raise whose comment failed to post is settled on the next start, once", async (t) => {
  const h = await harness(t);
  const post = h.forge.postComment.bind(h.forge);
  h.forge.postComment = async () => {
    throw new Error("the forge did not answer");
  };
  const ticket = await raised(h, 7, needsTheOwner(), T7);
  assert.equal(ticket.state, "on-the-board", "the raise is recorded though the comment failed");
  assert.equal(h.forge.state.sends.comment, 0);
  assert.equal(h.notices().length, 1);

  h.forge.postComment = post;
  const settled = await settleUnconfirmedWrites(h.setup.store, () => h.forge);
  assert.deepEqual(settled.map((s) => ("settled" in s ? s.settled : s.error.message)), ["not found, so posted", "applied again"]);
  assert.equal(h.forge.state.comments["issue:7"]!.length, 1);
  assert.deepEqual(h.forge.state.labels[7], ["entail:raised"], "the label the raise recorded goes out with it");
  await h.pass();
  assert.equal(h.forge.state.comments["issue:7"]!.length, 1, "not posted again");
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 1);
});

test("a ticket never has two open board items", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(7, T7)];
  h.scripted.script("verdict", "1", { output: needsTheOwner() });
  await h.pass();
  const deciding = h.ticket(7);
  const verdictCall = owedRaise(deciding, h.setup.store.callsForTicket(deciding.id))!;
  assert.notEqual(verdictCall, null, "a needs-the-owner verdict owes a raise");
  const options = {
    store: h.setup.store,
    log: h.setup.log,
    dataDirectory: h.setup.dataDirectory,
    notifier: h.notifier,
    boardOrigin: ORIGIN,
  };
  const writer = { repo: h.repo, writer: () => ({ comment: async () => ({ id: 1, url: "u" }), addLabel: async () => {} }) as never };
  const request = raiseFromVerdict(deciding, verdictCall);
  const [first, second] = await Promise.all([raiseToBoard(options, request, writer, h.mirror), raiseToBoard(options, request, writer, h.mirror)]);
  assert.equal([first, second].filter((item) => item !== null).length, 1, "two raises at once make one item");
  assert.equal(h.setup.store.boardItemsForTicket(deciding.id).length, 1);
  assert.equal(owedRaise(h.ticket(7), h.setup.store.callsForTicket(deciding.id)), null, "nothing more is owed");

  const raise = h.setup.store.callsForTicket(deciding.id).at(-1)!;
  assert.throws(
    () => h.setup.store.raiseBoardItem({ ticketId: deciding.id, callId: raise.id, decision: "Again?", whyRaised: "pin", snapshot: {} }),
    /already has an open board item/,
    "the store refuses a second open item",
  );
});

test("settled and unopposed verdicts that pass their checks owe no raise", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1)];
  h.scripted.script("verdict", "1", {
    output: needsTheOwner({ verdict: "unopposed", why_raised: null, open_readings: [], vision_check: [], why_unopposed: "Nothing opposes it.", reading_chosen: "R1" }),
  });
  await h.pass();
  await h.pass();
  const ticket = h.ticket(1);
  assert.equal(ticket.state, "deciding");
  assert.equal(owedRaise(ticket, h.setup.store.callsForTicket(ticket.id)), null);
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 0);
  assert.equal(h.notices().length, 0);
});

test("a ticket pulled in again shows its predecessor's calls and answer among what happened", async (t) => {
  const h = await harness(t);
  const { store } = h.setup;
  const first = await raised(h, 7, needsTheOwner(), T7);
  const item = store.openBoardItem(first.id)!;
  const answer = store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "dont-go-ahead", note: "private", showNoteOnIssue: false });
  store.recordCall({ ticketId: first.id, kind: "cancel-on-outside-close", reason: "Cancelled after the owner's answer.", answerId: answer.id, stateTo: "cancelled" });

  const again = store.takeIn({ repoId: h.repo.id, issueNumber: 7, predecessorId: first.id });
  const intake = store.callsForTicket(first.id)[0]!;
  store.recordCall({ ticketId: again.id, kind: "intake", reason: "Pulled in again.", inputs: intake.inputs, detail: intake.detail });
  const verdict = store.callsForTicket(first.id).find((c) => c.kind === "verdict")!;
  const verdictAgain = store.recordCall({ ticketId: again.id, kind: "verdict", reason: verdict.reason, inputs: verdict.inputs, detail: verdict.detail });

  const writer = { repo: h.repo, writer: () => ({ comment: async () => ({ id: 2, url: "u" }), addLabel: async () => {} }) as never };
  const options = { store, log: h.setup.log, dataDirectory: h.setup.dataDirectory, notifier: h.notifier, boardOrigin: ORIGIN };
  const raisedAgain = await raiseToBoard(options, raiseFromVerdict(store.getTicket(again.id)!, verdictAgain), writer, h.mirror);
  const snapshot = raisedAgain!.snapshot as BoardItemSnapshot;
  assert.deepEqual(
    snapshot.happened.calls.map((c) => [c.ticketId, c.kind]),
    [
      [again.id, "raise"],
      [again.id, "verdict"],
      [again.id, "intake"],
      [first.id, "cancel-on-outside-close"],
      [first.id, "raise"],
      [first.id, "verdict"],
      [first.id, "intake"],
    ],
  );
  assert.deepEqual(snapshot.happened.answers.map((a) => [a.ticketId, a.shape, a.answeredBy]), [[first.id, "dont-go-ahead", "Ada"]]);
  assert.ok(!JSON.stringify(snapshot).includes("private"), "the owner's private note is never part of the item");
});
