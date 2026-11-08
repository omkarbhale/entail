import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { boardPlanner, owedRaise, type BoardItemSnapshot } from "../src/board-item.ts";
import { deciderPlanner, type RecordedVerdict } from "../src/decider.ts";
import { Mirror } from "../src/mirror.ts";
import type { VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import type { Pin, RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import { checkVerdict, VERDICT_CHECKS, type VerdictChecks } from "../src/verdict-checks.ts";
import { splitVisionLines, type VisionAtCommit } from "../src/vision.ts";
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
const FORMAT_PIN: Pin = { topic: "the output format", paths: ["src/format.js"], keywords: [] };

const R1 = { id: "R1", reading: "Split words on whitespace only.", observed_outcome: "`tally` counts `a-b` as one word." };
const R2 = { id: "R2", reading: "Split words on punctuation too.", observed_outcome: "`tally` counts `a-b` as two words." };

/** A settled verdict that passes every check, with every field the schema asks for. */
function settled(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return {
    size: { value: "fits", reason: "One change to the word splitter." },
    readings: [R1, R2],
    pins_touched: [],
    vision_check: [{ line: "A word is a run of characters between whitespace.", mark: "matches" }],
    verdict: "settled",
    citations: [{ lines: ["A word is a run of characters between whitespace."], reading: "R1" }],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: null,
    open_readings: [],
    reason: "The vision defines a word, which chooses R1.",
    ...fields,
  };
}

/** An unopposed verdict that passes every check. */
function unopposed(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return settled({
    readings: [{ id: "R1", reading: "Read stdin when no file is given.", observed_outcome: "`echo a b | tally` prints 2." }],
    vision_check: [{ line: "tally counts the words of text files.", mark: "does_not_settle" }],
    verdict: "unopposed",
    citations: [],
    why_unopposed: "No line speaks to standard input.",
    reading_chosen: "R1",
    reason: "Nothing in the vision opposes reading standard input.",
    ...fields,
  });
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
  engine: Passes;
  visionSha: string;
  pass(): Promise<void>;
  ticket(issueNumber: number): TicketRecord;
}

async function harness(t: TestContext, pins: Pin[] = []): Promise<Harness> {
  const setup = passSetup(t);
  const repo = setup.enroll();
  if (pins.length > 0) {
    const settings = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
    setup.store.saveSettings(repo.id, { ...settings, pins }, "Ada");
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
  const notifier = new Notifier({ connectorName: () => "file", connectors: {}, dataDirectory: setup.dataDirectory, log: setup.log });
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
    engine,
    visionSha,
    async pass() {
      await engine.runPass();
      await until(() => engine.stepsRunning === 0, "every step started has finished");
    },
    ticket: (issueNumber) => setup.store.latestTicketForIssue(repo.id, issueNumber)!,
  };
}

/** Takes issue 1 in with the given verdict, records it, and routes it. */
async function judged(h: Harness, output: VerdictOutput, fields: Partial<Parameters<typeof issue>[1]> = {}): Promise<TicketRecord> {
  h.forge.issues = [issue(1, { title: "Count hyphenated words", body: "Is `a-b` one word or two?", ...fields })];
  h.scripted.script("verdict", "1", { output, facts: { sessionId: "decider-session" } });
  await h.pass();
  await h.pass();
  return h.ticket(1);
}

function verdictCall(h: Harness, ticket: TicketRecord) {
  return h.setup.store.callsForTicket(ticket.id).find((call) => call.kind === "verdict")!;
}

/** VISION.md as read at a commit, for checking a verdict without a repo. */
function visionAt(commit: string, content = VISION): VisionAtCommit {
  return { status: "present", commit, blob: "b".repeat(40), lines: splitVisionLines(content) };
}

/** A verdict as recorded, with what entail adds, for the pure checks. */
function recorded(output: VerdictOutput, fields: Partial<RecordedVerdict> = {}): RecordedVerdict {
  return {
    ...output,
    model: "claude-opus-5-5",
    session_id: "s",
    vision_sha: "a".repeat(40),
    duration_ms: 0,
    estimated_cost_usd: 0,
    usage: null,
    pin_matches: [],
    ...fields,
  };
}

function failed(checks: VerdictChecks): string[] {
  return checks.results.filter((r) => !r.passed).map((r) => r.check);
}

test("a verdict that is right on every count passes every check", () => {
  for (const output of [settled(), unopposed()]) {
    const checks = checkVerdict(recorded(output), visionAt("a".repeat(40)));
    assert.equal(checks.passed, true);
    assert.deepEqual(
      checks.results.map((r) => [r.check, r.passed, r.failure]),
      Object.values(VERDICT_CHECKS).map((check) => [check, true, null]),
      "every check is recorded, in order",
    );
  }
  // Whitespace is collapsed, as vision lines are identified.
  const spaced = settled({
    vision_check: [{ line: "A word is a run of  characters between whitespace. ", mark: "matches" }],
    citations: [{ lines: ["A  word is a run of characters between whitespace."], reading: "R1" }],
  });
  assert.equal(checkVerdict(recorded(spaced), visionAt("a".repeat(40))).passed, true);
});

test("each check fails a crafted verdict on its own", () => {
  const vision = visionAt("a".repeat(40));
  const cases: [string, RecordedVerdict, string, RegExp][] = [
    [
      "a cited line not in VISION.md",
      recorded(settled({ citations: [{ lines: ["A word is anything between spaces."], reading: "R1" }], vision_check: [{ line: "A word is anything between spaces.", mark: "matches" }] })),
      VERDICT_CHECKS.wordForWord,
      /“A word is anything between spaces\.” is not word for word a line of VISION\.md at aaaaaaa/,
    ],
    [
      "a vision-check line not in VISION.md",
      recorded(unopposed({ vision_check: [{ line: "tally reads files only.", mark: "does_not_settle" }] })),
      VERDICT_CHECKS.wordForWord,
      /“tally reads files only\.”/,
    ],
    ["settled with no citation", recorded(settled({ citations: [] })), VERDICT_CHECKS.settledCites, /cites no passage/],
    [
      "a settled citation not marked matches",
      recorded(settled({ vision_check: [{ line: "A word is a run of characters between whitespace.", mark: "does_not_settle" }] })),
      VERDICT_CHECKS.settledCites,
      /is marked “does_not_settle”, not “matches”/,
    ],
    [
      "a settled citation missing from the vision check",
      recorded(settled({ vision_check: [] })),
      VERDICT_CHECKS.settledCites,
      /is not in the vision check/,
    ],
    [
      "a citation that points to no listed reading",
      recorded(settled({ citations: [{ lines: ["A word is a run of characters between whitespace."], reading: "R9" }] })),
      VERDICT_CHECKS.choosesOneReading,
      /points to “R9”, which is not one of the verdict's readings/,
    ],
    [
      "an unopposed verdict that chooses none of several readings",
      recorded(unopposed({ readings: [R1, R2], reading_chosen: null })),
      VERDICT_CHECKS.choosesOneReading,
      /lists 2 readings and chooses none/,
    ],
    [
      "a line marked contradicts",
      recorded(unopposed({ vision_check: [{ line: "tally never reaches the network.", mark: "contradicts" }] })),
      VERDICT_CHECKS.noContradiction,
      /marks “tally never reaches the network\.” as contradicted/,
    ],
    [
      "a pin the model judged touched",
      recorded(unopposed({ pins_touched: [{ pin: "the output format", why: "it changes what is printed" }] })),
      VERDICT_CHECKS.noPin,
      /touches the pin “the output format”: it changes what is printed/,
    ],
    [
      "a pin entail's matching found touched",
      recorded(unopposed(), { pin_matches: [{ pin: "the output format", by: "path", glob: "src/format.js", path: "src/format.js" }] }),
      VERDICT_CHECKS.noPin,
      /the issue names src\/format\.js, which its path src\/format\.js matches/,
    ],
  ];
  for (const [name, verdict, check, failure] of cases) {
    const checks = checkVerdict(verdict, vision);
    assert.equal(checks.passed, false, name);
    assert.deepEqual(failed(checks), [check], `${name}: only ${check} fails`);
    assert.match(checks.results.find((r) => r.check === check)!.failure!, failure, name);
  }

  const elsewhere = checkVerdict(recorded(settled()), visionAt("c".repeat(40)));
  assert.deepEqual(failed(elsewhere), [VERDICT_CHECKS.wordForWord], "quotes are checked at the verdict's recorded sha only");
  const missing = checkVerdict(recorded(settled()), { status: "missing", commit: "a".repeat(40) });
  assert.deepEqual(failed(missing), [VERDICT_CHECKS.wordForWord]);
  assert.throws(() => checkVerdict(recorded(settled({ verdict: "needs_the_owner" })), vision), /only a settled or unopposed verdict/);
});

for (const [check, output, fields, pins] of [
  [
    VERDICT_CHECKS.wordForWord,
    settled({
      citations: [{ lines: ["A word is anything between spaces."], reading: "R1" }],
      vision_check: [{ line: "A word is anything between spaces.", mark: "matches" }],
    }),
    {},
    [],
  ],
  [VERDICT_CHECKS.settledCites, settled({ citations: [] }), {}, []],
  [VERDICT_CHECKS.choosesOneReading, unopposed({ readings: [R1, R2], reading_chosen: null }), {}, []],
  [VERDICT_CHECKS.noContradiction, unopposed({ vision_check: [{ line: "tally never reaches the network.", mark: "contradicts" }] }), {}, []],
  [VERDICT_CHECKS.noPin, unopposed(), { title: "Tidy `src/format.js`" }, [FORMAT_PIN]],
] as const) {
  test(`a verdict failing "${check}" goes to the board with that failure as why_raised, unchallenged`, async (t) => {
    const h = await harness(t, [...pins]);
    const ticket = await judged(h, output, fields);

    const call = verdictCall(h, ticket);
    const checks = call.checks as VerdictChecks;
    assert.equal(checks.passed, false);
    assert.equal(checks.vision_sha, h.visionSha);
    assert.equal(failed(checks)[0], check);
    assert.equal(call.challenge, null, "no challenge runs after a failed check");
    assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"]);
    assert.deepEqual(call.modelRuns.map((r) => r.purpose), ["verdict"]);

    assert.equal(ticket.state, "on-the-board", "a failed check is a product failure, never retried");
    const item = h.setup.store.openBoardItem(ticket.id)!;
    assert.equal(item.whyRaised, "failed_check");
    const snapshot = item.snapshot as BoardItemSnapshot;
    assert.equal(snapshot.why.failedCheck?.check, check);
    assert.equal(snapshot.why.failedCheck?.failure, checks.results.find((r) => r.check === check)!.failure);
    assert.match(snapshot.why.text, new RegExp(`the check “${check}” failed`));
    assert.equal(snapshot.why.tag, "failed check");
    const raise = h.setup.store.callsForTicket(ticket.id).at(-1)!;
    assert.equal(raise.kind, "raise");
    assert.equal((raise.detail as { basedOnCallId: number }).basedOnCallId, call.id);
    if (check === VERDICT_CHECKS.noPin) assert.deepEqual(snapshot.why.pins.map((p) => p.pin), ["the output format"], "the touched pin is named");
  });
}

test("cited passages that point to different readings send the ticket to the board quoting both", async (t) => {
  const h = await harness(t);
  const output = settled({
    vision_check: [
      { line: "A word is a run of characters between whitespace.", mark: "matches" },
      { line: "Output is plain text, one count per line.", mark: "matches" },
    ],
    citations: [
      { lines: ["A word is a run of characters between whitespace."], reading: "R1" },
      { lines: ["Output is plain text, one count per line."], reading: "R2" },
    ],
  });
  const ticket = await judged(h, output);

  const checks = verdictCall(h, ticket).checks as VerdictChecks;
  assert.deepEqual(failed(checks), [VERDICT_CHECKS.choosesOneReading]);
  assert.deepEqual(checks.open_readings, ["R1", "R2"]);
  assert.equal(h.scripted.requests.length, 1, "no challenge");

  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.match(snapshot.why.text, /the vision does not settle the ticket/);
  assert.match(snapshot.why.text, /“A word is a run of characters between whitespace\.” points to R1 \(Split words on whitespace only\.\)/);
  assert.match(snapshot.why.text, /“Output is plain text, one count per line\.” points to R2 \(Split words on punctuation too\.\)/);
  assert.deepEqual(snapshot.form.options.map((o) => [o.id, o.title]), [["R1", R1.reading], ["R2", R2.reading]], "each reading a passage points to is an option");
  assert.deepEqual(
    snapshot.visionCheck.lines.map((line) => line.text),
    ["A word is a run of characters between whitespace.", "Output is plain text, one count per line."],
    "both passages are quoted in the vision check",
  );
});

for (const [name, output] of [
  ["settled", settled()],
  ["unopposed", unopposed()],
] as const) {
  test(`a ${name} verdict that passes its checks is recorded with them, unchallenged, and left for its criteria`, async (t) => {
    const h = await harness(t, [FORMAT_PIN]);
    const ticket = await judged(h, output);

    assert.equal(ticket.state, "deciding", "a verdict that passes its checks is left for criteria");
    assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 0);
    assert.equal(owedRaise(ticket, h.setup.store.callsForTicket(ticket.id)), null);
    assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"], "the challenge runs once over the verdict and its criteria together");

    const call = verdictCall(h, ticket);
    const checks = call.checks as VerdictChecks;
    assert.equal(checks.passed, true);
    assert.equal(checks.results.length, Object.keys(VERDICT_CHECKS).length);
    assert.equal(call.challenge, null);
    assert.deepEqual(call.modelRuns.map((r) => [r.purpose, r.sessionId]), [["verdict", "decider-session"]]);
  });
}

test("a needs-the-owner verdict gets no checks and no challenge", async (t) => {
  const h = await harness(t);
  const ticket = await judged(
    h,
    settled({ verdict: "needs_the_owner", citations: [], why_raised: "consequential_readings", open_readings: ["R1", "R2"], vision_check: [] }),
  );
  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"]);
  const call = verdictCall(h, ticket);
  assert.equal(call.checks, null);
  assert.equal(call.challenge, null);
  assert.equal(h.setup.store.openBoardItem(ticket.id)!.whyRaised, "consequential_readings");
});
