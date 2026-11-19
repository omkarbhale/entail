import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { overrideCall, waitingItems } from "../src/owner.ts";
import { judgmentPrompt, type IssueCall, type JudgmentInputs } from "../src/judgment.ts";
import { appendEntry, readLog, repoState, type CallEntry, type Entry } from "../src/records.ts";
import { knownKinds, normalizeKind, RULING_MIN_ANSWERS, rulingFor, settleByRuling } from "../src/rulings.ts";
import { harness, OWNER, REPO, VISION, verdict } from "./watch-fixture.ts";

const KIND = "new-dependency";
const NOW = new Date("2026-11-18T12:00:00Z");

const ask = (overrides: Partial<Extract<IssueCall, { call: "ask" }>> = {}): Extract<IssueCall, { call: "ask" }> => ({
  call: "ask",
  reason: "A new dependency changes what users install.",
  restsOn: { visionLines: ["tally counts words offline."], cases: [] },
  question: "May tally depend on the `wcwidth` package?",
  why: "Two readings give users different installs.",
  large: false,
  criteria: [{ source: "reading", criterion: "Read as: the dependency is optional.", basis: "Two readings." }],
  kind: KIND,
  ...overrides,
});

interface Seeded {
  call: CallEntry;
  action: Entry;
}

let issueNumber = 100;

/** An ask of `kind` that the board answered, written to the repo's log as the board would have. */
function seedAnswered(dataDirectory: string, options: { kind?: string; to?: "go" | "no"; scope?: "plan"; by?: string; large?: boolean; holdUntil?: string; repo?: string } = {}): Seeded {
  const repo = options.repo ?? REPO;
  const number = issueNumber++;
  const at = new Date("2026-11-13T09:00:00Z");
  const call = appendEntry(
    dataDirectory,
    repo,
    {
      type: "call",
      issue: { number, title: `Add a dependency #${number}`, url: `https://github.com/${repo}/issues/${number}`, author: "reporter", createdAt: "2026-11-13T08:00:00Z" },
      trigger: "new",
      mentions: [],
      content: `hash-${number}`,
      issueText: `# Add a dependency #${number}\n`,
      vision: { commit: "a".repeat(40), text: VISION },
      sha: "a".repeat(40),
      call: ask({ kind: options.kind ?? KIND, large: options.large ?? false }),
      confirm: true,
      owner: null,
      model: "claude-opus-5-5",
      effort: "low",
      promptVersion: "issue-call-6",
      costUsd: 0.05,
    },
    at,
  );
  const action = appendEntry(
    dataDirectory,
    repo,
    { type: "answered", by: options.by ?? OWNER, call: call.id, to: options.to ?? "go", ...(options.scope === undefined ? {} : { scope: options.scope }), answer: `Yes, ${number} is fine.`, ...(options.holdUntil === undefined ? {} : { holdUntil: options.holdUntil }) },
    new Date("2026-11-14T09:00:00Z"),
  );
  return { call, action };
}

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "entail-rulings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a kind's name is the same however it is written", () => {
  assert.equal(normalizeKind("New Dependency"), "new-dependency");
  assert.equal(normalizeKind("  new_dependency!! "), "new-dependency");
  assert.equal(normalizeKind("---"), "");
  assert.equal(normalizeKind(""), "");
  assert.ok(normalizeKind("x".repeat(200)).length <= 60);
});

test("a ruling forms only after several answers the same way and none the other", (t) => {
  const dir = temporaryDirectory(t);
  const standing = () => rulingFor(readLog(dir, REPO), KIND, NOW);
  assert.deepEqual(standing(), { earned: false, why: "no board answer to this kind of question yet" });
  for (let answered = 1; answered < RULING_MIN_ANSWERS; answered++) {
    seedAnswered(dir);
    const result = standing();
    assert.equal(result.earned, false);
    assert.match((result as { why: string }).why, new RegExp(`${answered} of the ${RULING_MIN_ANSWERS} consistent answers`, "u"));
  }
  seedAnswered(dir);
  const earned = standing();
  assert.equal(earned.earned, true);
  assert.equal((earned as { outcome: string }).outcome, "go");
  assert.equal((earned as { answers: unknown[] }).answers.length, RULING_MIN_ANSWERS);

  // A later answer that disagrees stops the ruling being used.
  seedAnswered(dir, { to: "no" });
  const disputed = standing();
  assert.equal(disputed.earned, false);
  assert.match((disputed as { why: string }).why, /disagree/u);
});

test("an answer that disagrees stops a ruling even when it came first", (t) => {
  const dir = temporaryDirectory(t);
  seedAnswered(dir, { to: "no" });
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(dir);
  assert.equal(rulingFor(readLog(dir, REPO), KIND, NOW).earned, false);
});

test("another kind's answers do not count, and a kind is matched however it was written", (t) => {
  const dir = temporaryDirectory(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(dir, { kind: "Other Kind" });
  assert.equal(rulingFor(readLog(dir, REPO), KIND, NOW).earned, false);
  assert.equal(rulingFor(readLog(dir, REPO), "other-kind", NOW).earned, true);
  assert.equal(rulingFor(readLog(dir, REPO), "OTHER kind", NOW).earned, true);
});

test("an answer still in its undo window, or undone, does not count", (t) => {
  const dir = temporaryDirectory(t);
  seedAnswered(dir);
  seedAnswered(dir);
  const held = seedAnswered(dir, { holdUntil: "2026-11-18T12:00:10Z" });
  assert.equal(rulingFor(readLog(dir, REPO), KIND, NOW).earned, false, "the third is held");
  assert.equal(rulingFor(readLog(dir, REPO), KIND, new Date("2026-11-18T12:00:11Z")).earned, true, "its window closed");
  appendEntry(dir, REPO, { type: "undone", by: OWNER, action: held.action.id }, NOW);
  assert.equal(rulingFor(readLog(dir, REPO), KIND, new Date("2026-11-18T12:00:11Z")).earned, false, "undone");
});

test("answers to a question about a change that is hard to undo earn nothing a smaller change can ride on", (t) => {
  const dir = temporaryDirectory(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(dir, { large: true });
  assert.equal(rulingFor(readLog(dir, REPO), KIND, NOW).earned, false);
});

test("a go and a go for planning are not the same answer", (t) => {
  const dir = temporaryDirectory(t);
  seedAnswered(dir);
  seedAnswered(dir);
  seedAnswered(dir, { scope: "plan" });
  assert.equal(rulingFor(readLog(dir, REPO), KIND, NOW).earned, false);
});

test("settling cites the answers by name, carries the ask's criteria and rests on no vision line", (t) => {
  const dir = temporaryDirectory(t);
  seedAnswered(dir, { by: "Omkar" });
  seedAnswered(dir, { by: "Priya" });
  seedAnswered(dir, { by: "Omkar" });
  const settled = settleByRuling(ask(), { entries: readLog(dir, REPO), issueText: "Add wcwidth", pins: [], now: NOW });
  assert.equal(settled.notSettled, null);
  assert.equal(settled.call.call, "go");
  assert.deepEqual(settled.call.restsOn, { visionLines: [], cases: [] });
  const { ruling } = settled.call as Extract<IssueCall, { call: "go" }>;
  assert.deepEqual(ruling!.answers.map((answer) => answer.by), ["Omkar", "Priya", "Omkar"]);
  assert.match(settled.call.reason, /"new-dependency".*3 answers.*all go.*none the other way/su);
  assert.deepEqual((settled.call as Extract<IssueCall, { call: "go" }>).criteria, ask().criteria);
  assert.equal(ruling!.asked.question, ask().question, "the question as it would have been asked stays in the log");
  assert.doesNotMatch(settled.call.reason, /wcwidth/u, "the reason is posted, and the question is not");
});

test("a ruling of no settles with a no, and a ruling of go for planning with a go for planning", (t) => {
  const dir = temporaryDirectory(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(dir, { kind: "telemetry", to: "no" });
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(dir, { kind: "rewrites", scope: "plan" });
  const entries = readLog(dir, REPO);
  const no = settleByRuling(ask({ kind: "telemetry" }), { entries, issueText: "x", pins: [], now: NOW });
  assert.equal(no.call.call, "no");
  assert.equal((no.call as Extract<IssueCall, { call: "no" }>).ruling!.outcome, "no");
  const plan = settleByRuling(ask({ kind: "rewrites" }), { entries, issueText: "x", pins: [], now: NOW });
  assert.equal(plan.call.call, "go");
  assert.equal((plan.call as Extract<IssueCall, { call: "go" }>).scope, "plan");
});

test("a call that is not an ask, and an ask a ruling may not settle, come out as they were", (t) => {
  const dir = temporaryDirectory(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(dir);
  const entries = readLog(dir, REPO);
  const context = { entries, issueText: "Add the wcwidth package", pins: [], now: NOW };

  const go: IssueCall = { call: "go", reason: "r", restsOn: { visionLines: [], cases: [] }, criteria: [], scope: "implement" };
  assert.equal(settleByRuling(go, context).call, go);
  const no: IssueCall = { call: "no", reason: "r", restsOn: { visionLines: ["x"], cases: [] } };
  assert.equal(settleByRuling(no, context).call, no);

  const large = ask({ large: true });
  assert.equal(settleByRuling(large, context).call, large, "a large or hard-to-undo change always reaches the owner");
  assert.match(settleByRuling(large, context).notSettled!, /large or hard to undo/u);

  const pinned = settleByRuling(ask(), { ...context, pins: ["wcwidth"] });
  assert.equal(pinned.call.call, "ask", "a pinned topic always reaches the owner");
  assert.match(pinned.notSettled!, /pinned topic \(wcwidth\)/u);
  assert.equal(settleByRuling(ask(), { ...context, pins: ["WCWIDTH package"] }).call.call, "ask");

  const unnamed = ask({ kind: "" });
  assert.equal(settleByRuling(unnamed, context).call, unnamed);
  const old = ask();
  delete old.kind;
  assert.equal(settleByRuling(old, context).call, old, "a question logged before kinds were kept names none");
});

test("the prompt lists the kinds a repo has asked only when there are some, and says how to name one", () => {
  const inputs: JudgmentInputs = { repo: REPO, issueNumber: 7, issueText: "# x", vision: null, pins: [], precedents: [], checkout: "/c", sha: "a".repeat(40) };
  const fresh = judgmentPrompt(inputs);
  assert.match(fresh, /Also name the \*\*kind\*\* of question it is in question_kind/u);
  assert.doesNotMatch(fresh, /## Kinds of question already asked/u);
  assert.equal(judgmentPrompt({ ...inputs, kinds: [] }), fresh, "no kinds is the prompt as a fresh repo reads it");

  const listed = judgmentPrompt({
    ...inputs,
    kinds: [
      { kind: "new-dependency", answers: 3, outcome: "go" },
      { kind: "default-on-or-opt-in", answers: 2, outcome: null },
      { kind: "telemetry", answers: 0, outcome: null },
    ],
  });
  assert.match(listed, /## Kinds of question already asked\n\nThese are the kinds[^\n]*They are only names: nothing here settles this issue\.\n\n- new-dependency \(answered 3 times, all go\)\n- default-on-or-opt-in \(answered 2 times, not all the same way\)\n- telemetry \(asked, not answered yet\)\n\n## The issue/u);
});

test("the kinds a repo has asked are known from its log, newest first, with how they were answered", (t) => {
  const dir = temporaryDirectory(t);
  seedAnswered(dir, { kind: "first-kind" });
  seedAnswered(dir, { kind: "second-kind", to: "no" });
  seedAnswered(dir, { kind: "second-kind", to: "go" });
  assert.deepEqual(knownKinds(readLog(dir, REPO), NOW), [
    { kind: "second-kind", answers: 2, outcome: null },
    { kind: "first-kind", answers: 1, outcome: "go" },
  ]);
});

// The whole pass.

const dependencyAsk = (overrides: Partial<ReturnType<typeof verdict>> = {}) =>
  verdict({
    call: "ask",
    reason: "A new dependency changes what users install.",
    rests_on: { vision_lines: ["tally counts words offline."], cases: [] },
    question: { question: "May tally depend on the wcwidth package?", why: "Two readings give users different installs." },
    question_kind: KIND,
    criteria: [{ source: "reading", criterion: "Read as: the dependency is optional.", basis: "Two readings." }],
    ...overrides,
  });

const calls = (dataDirectory: string): CallEntry[] => readLog(dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call");

test("a question of a kind the board has settled the same way is settled by the ruling, citing the answers, and never reaches the owner", async (t) => {
  const h = harness(t);
  seedAnswered(h.dataDirectory, { by: "Omkar" });
  seedAnswered(h.dataDirectory, { by: "Priya" });
  seedAnswered(h.dataDirectory, { by: "Omkar" });
  h.forge.file(31, "Use wcwidth for column widths", "Widths of wide characters are wrong.");
  h.script(31, dependencyAsk());

  const report = await h.pass();
  assert.equal(report.judged, 1);

  // The prompt named the kinds already asked, so the question was named the same way.
  assert.match(h.runner.requests[0]!.prompt, /- new-dependency \(answered 3 times, all go\)/u);

  const [call] = calls(h.dataDirectory).filter((entry) => entry.issue.number === 31);
  assert.equal(call!.call.call, "go");
  const settled = call!.call as Extract<IssueCall, { call: "go" }>;
  assert.equal(settled.scope, "implement");
  assert.deepEqual(settled.ruling!.answers.map((answer) => answer.by), ["Omkar", "Priya", "Omkar"]);
  assert.deepEqual(settled.restsOn, { visionLines: [], cases: [] });
  assert.match(settled.reason, /the board has settled before \("new-dependency"\)/u, "the reason is logged with the call");
  assert.equal(call!.vision!.text, VISION, "the vision the call read is the repo's, untouched");

  // Posted on the issue: the answers by name, none of the question or the words, and the criteria the ask carried.
  const { body } = h.forge.posted[0]!;
  assert.match(body, /\*\*Go\.\*\* This is a kind of question the board has settled before/u);
  assert.match(body, /- Omkar answered go on #\d+ \(2026-11-14\)\n- Priya answered go on #\d+ \(2026-11-14\)\n- Omkar answered go on #\d+ \(2026-11-14\)/u);
  assert.doesNotMatch(body, /wcwidth|Yes, 10\d is fine/u);
  assert.doesNotMatch(body, /^> /mu, "no vision passage is quoted");
  assert.match(body, /- Read as: the dependency is optional\./u);

  // Confirm mode still holds a go for the owner to confirm; it is a confirmation card, not a question.
  const [item] = waitingItems(h.dataDirectory, []).filter((one) => one.issue!.number === 31);
  assert.equal(item!.call, "go");
  assert.equal(item!.question, null);
  assert.deepEqual(item!.ruling!.answers.map((answer) => [answer.by, answer.outcome]), [["Omkar", "go"], ["Priya", "go"], ["Omkar", "go"]]);
  assert.equal(item!.ruling!.asked.question, "May tally depend on the wcwidth package?");

  assert.equal(h.forge.labelWrites.at(-1) === "+entail:go #31", false, "in confirm mode the label comes with the confirmation");
});

test("with confirm mode off a ruling of no closes the issue with the ruling's reason and the answers", async (t) => {
  const h = harness(t, { confirm: false });
  for (const by of ["Omkar", "Priya", "Sam"]) seedAnswered(h.dataDirectory, { kind: "telemetry", to: "no", by });
  h.forge.file(32, "Send usage stats home");
  h.script(32, dependencyAsk({ question_kind: "Telemetry" }));
  await h.pass();
  const [call] = calls(h.dataDirectory).filter((entry) => entry.issue.number === 32);
  assert.equal(call!.call.call, "no");
  assert.equal(call!.confirm, false);
  assert.deepEqual(h.forge.closed, [32]);
  const { body } = h.forge.posted[0]!;
  assert.match(body, /\*\*No\.\*\* This is a kind of question the board has settled before \("telemetry"\)/u);
  assert.match(body, /- Sam answered no on #\d+ \(2026-11-14\)/u);
  assert.match(body, /Closing the issue as not planned\./u);
});

test("a question of a kind with too few answers, or answers that disagree, still goes to the owner", async (t) => {
  const h = harness(t);
  seedAnswered(h.dataDirectory);
  seedAnswered(h.dataDirectory);
  h.forge.file(33, "Use wcwidth");
  h.script(33, dependencyAsk());
  await h.pass();
  assert.equal(calls(h.dataDirectory).find((entry) => entry.issue.number === 33)!.call.call, "ask");

  seedAnswered(h.dataDirectory);
  seedAnswered(h.dataDirectory, { to: "no" });
  h.forge.file(34, "Use wcwidth, again");
  h.script(34, dependencyAsk());
  await h.pass();
  const asked = calls(h.dataDirectory).find((entry) => entry.issue.number === 34)!;
  assert.equal(asked.call.call, "ask");
  assert.equal((asked.call as Extract<IssueCall, { call: "ask" }>).kind, KIND);
  assert.match(h.forge.posted.at(-1)!.body, /A question about this issue is waiting for Omkar/u);
});

test("a call that is not an ask comes out as the model made it, whatever rulings are earned", async (t) => {
  const h = harness(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(h.dataDirectory, { kind: "telemetry", to: "no" });
  h.forge.file(35, "Count words in footnotes");
  h.forge.file(36, "Upload counts");
  h.script(35, verdict({ question_kind: "telemetry" }));
  h.script(36, verdict({ call: "no", reason: "Against the vision.", rests_on: { vision_lines: ["tally counts words offline."], cases: [] }, question_kind: "telemetry" }));
  await h.pass();
  const [go, no] = ["35", "36"].map((number) => calls(h.dataDirectory).find((entry) => entry.issue.number === Number(number))!.call);
  assert.deepEqual(go, { call: "go", reason: "Counting words in more places makes tally more useful.", restsOn: { visionLines: [], cases: [] }, criteria: [], scope: "implement" });
  assert.deepEqual(no, { call: "no", reason: "Against the vision.", restsOn: { visionLines: ["tally counts words offline."], cases: [] } });
});

test("a large or hard-to-undo change, or one touching a pinned topic, is asked whatever has been answered", async (t) => {
  const h = harness(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(h.dataDirectory);
  h.forge.file(37, "Replace the log format");
  h.script(37, dependencyAsk({ hard_to_undo: true, large_because: "It replaces the log format.", call: "go" }));
  h.forge.file(38, "Use wcwidth for billing totals");
  h.script(38, dependencyAsk());
  await h.pass({ reader: async () => ({ checkout: "/checkout", sha: "a".repeat(40), vision: { text: VISION, commit: "a".repeat(40) }, pins: ["billing"] }) });
  const [large, pinned] = [37, 38].map((number) => calls(h.dataDirectory).find((entry) => entry.issue.number === number)!);
  assert.equal(large!.call.call, "ask");
  assert.equal((large!.call as Extract<IssueCall, { call: "ask" }>).large, true);
  assert.equal(pinned!.call.call, "ask");
});

test("an owner's override of a ruling's call is an answer that disagrees: the ruling is not used again", async (t) => {
  const h = harness(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(h.dataDirectory);
  h.forge.file(41, "Use wcwidth");
  h.script(41, dependencyAsk());
  await h.pass();
  const ruled = calls(h.dataDirectory).find((entry) => entry.issue.number === 41)!;
  assert.equal(ruled.call.call, "go");

  await overrideCall(h.dataDirectory, ruled.id, OWNER, "no", "Not this one: it pulls in a native build.", new Date(Date.now() - 60_000));
  assert.equal(rulingFor(readLog(h.dataDirectory, REPO), KIND, new Date()).earned, false);

  h.forge.file(42, "Use another dependency");
  h.script(42, dependencyAsk());
  await h.pass();
  assert.equal(calls(h.dataDirectory).find((entry) => entry.issue.number === 42)!.call.call, "ask");
});

test("the owner's own word is never replaced by a ruling", async (t) => {
  const h = harness(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(h.dataDirectory, { kind: "telemetry", to: "no" });
  h.forge.file(43, "Send usage stats home");
  h.script(43, dependencyAsk({ question_kind: "telemetry" }));
  await h.pass({ settings: { owner: OWNER, model: "claude-opus-5-5", effort: "low" } });
  // The ruling settled it with a no; the owner overrides to go and the judgment runs again on their word.
  const first = calls(h.dataDirectory).find((entry) => entry.issue.number === 43)!;
  await overrideCall(h.dataDirectory, first.id, OWNER, "go", "Fine, this once.", new Date(Date.now() - 60_000));
  // The rerun on the owner's word comes back as another ask of the same kind; it is not settled by the ruling.
  h.script(43, dependencyAsk({ question_kind: "telemetry" }));
  await h.pass();
  const rerun = calls(h.dataDirectory).filter((entry) => entry.issue.number === 43).at(-1)!;
  assert.notEqual(rerun.owner, null);
  assert.equal(rerun.call.call, "ask");
});

test("an owner-made call re-checked after a vision change and judged an ask stays an ask, whatever has been earned", async (t) => {
  const h = harness(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(h.dataDirectory, { kind: "telemetry", to: "no" });
  h.forge.file(45, "Send usage stats home");
  h.script(45, dependencyAsk({ question_kind: "telemetry" }));
  await h.pass();
  const first = calls(h.dataDirectory).find((entry) => entry.issue.number === 45)!;
  await overrideCall(h.dataDirectory, first.id, OWNER, "go", "Fine, this once.", new Date(Date.now() - 60_000));
  h.script(45, verdict());
  await h.pass();
  assert.equal(calls(h.dataDirectory).filter((entry) => entry.issue.number === 45).at(-1)!.owner?.call, "go");

  const newVision = "# Vision\n\ntally counts words offline.\ntally never adds a second output format.\n";
  const sha = "c".repeat(40);
  h.script(45, dependencyAsk({ question_kind: "telemetry", vision_change: "tally never adds a second output format." } as never));
  await h.pass({ reader: async () => ({ checkout: "/checkout", sha, vision: { text: newVision, commit: sha }, pins: [] }) });
  const rechecked = calls(h.dataDirectory).filter((entry) => entry.issue.number === 45).at(-1)!;
  assert.equal(rechecked.recheck?.previousCall, "go");
  assert.equal(rechecked.call.call, "ask");
});

test("a ruling is derived from the log and written nowhere: the repo's vision and the call's reading of it stay as they were", async (t) => {
  const h = harness(t);
  for (let i = 0; i < RULING_MIN_ANSWERS; i++) seedAnswered(h.dataDirectory);
  h.forge.file(44, "Use wcwidth");
  h.script(44, dependencyAsk());
  await h.pass();
  const entries = readLog(h.dataDirectory, REPO);
  const vision = entries.filter((entry) => entry.type === "vision-seen");
  assert.deepEqual(vision, [], "a ruling is not a change to the vision");
  assert.equal(JSON.stringify(entries).includes("ruling") && !h.forge.posted.some((post) => /VISION\.md/u.test(post.body)), true);
  assert.equal(repoState(REPO, entries).vision, null);
});
