import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { boardPlanner, type BoardItemSnapshot } from "../src/board-item.ts";
import { CHALLENGE_PROMPT_VERSION, type ChallengeOutput, type RecordedChallenge } from "../src/challenge.ts";
import { assertCommentRules } from "../src/comment-rules.ts";
import {
  checkCriteria,
  CRITERIA_CHECKS,
  CRITERIA_PROMPT_VERSION,
  criteriaInForce,
  criteriaPlanner,
  fenceGlobs,
  globProblem,
  type CriteriaChecks,
  type CriteriaContext,
  type CriteriaDetail,
} from "../src/criteria.ts";
import { deciderPlanner, judgedPins } from "../src/decider.ts";
import type { CommitChecks } from "../src/forge/forge.ts";
import { settleUnconfirmedWrites } from "../src/forge-writer.ts";
import { CLEARED_LABEL, EXECUTOR_LINE } from "../src/intake-comment.ts";
import { Mirror } from "../src/mirror.ts";
import type { CriteriaOutput, VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import type { GenericCriterion, Pin, RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import type { VerdictChecks } from "../src/verdict-checks.ts";
import { splitVisionLines } from "../src/vision.ts";
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
const G1: GenericCriterion = { id: "G1", sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, source: ".github/workflows/ci.yml" };
const WORD_LINE = "A word is a run of characters between whitespace.";

const R1 = { id: "R1", reading: "Split words on whitespace only.", observed_outcome: "`tally` counts `a-b` as one word." };
const R2 = { id: "R2", reading: "Split words on punctuation too.", observed_outcome: "`tally` counts `a-b` as two words." };

/** A settled verdict that passes every verdict check. */
function settled(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return {
    size: { value: "fits", reason: "One change to the word splitter." },
    readings: [R1, R2],
    pins_touched: [],
    vision_check: [{ line: WORD_LINE, mark: "matches" }],
    verdict: "settled",
    citations: [{ lines: [WORD_LINE], reading: "R1" }],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: null,
    open_readings: [],
    reason: "The vision defines a word, which chooses R1.",
    ...fields,
  };
}

/** An unopposed verdict, where entail chose R1 of two readings. */
function unopposed(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return settled({
    readings: [
      { id: "R1", reading: "Print one JSON object per input, one per line.", observed_outcome: "`tally --json a b` prints two lines of JSON." },
      { id: "R2", reading: "Print one JSON array of every input.", observed_outcome: "`tally --json a b` prints one JSON array." },
    ],
    vision_check: [{ line: "tally counts the words of text files.", mark: "does_not_settle" }],
    verdict: "unopposed",
    citations: [],
    why_unopposed: "No vision line speaks to machine-readable output.",
    reading_chosen: "R1",
    reason: "Nothing in the vision opposes a JSON flag.",
    ...fields,
  });
}

type CriterionOut = CriteriaOutput["criteria"][number];

function criterion(fields: Partial<CriterionOut> = {}): CriterionOut {
  return {
    id: "C1",
    sentence: "`tally` counts `a-b` as one word.",
    source: { kind: "issue", ref: null },
    checks: [],
    states_reading: null,
    ...fields,
  };
}

/** Criteria for the settled verdict that pass every check. */
function settledCriteria(...extra: CriterionOut[]): CriteriaOutput {
  return {
    outcome: "criteria",
    criteria: [
      criterion({ states_reading: "R1" }),
      criterion({ id: "C2", sentence: "Words stay runs of characters between whitespace.", source: { kind: "vision_line", ref: WORD_LINE }, checks: [{ kind: "check_passes", argument: "test" }] }),
      ...extra,
    ],
    product_call: null,
  };
}

/** Criteria for the unopposed verdict that pass every check: the reading chosen, fenced off the format pin and VISION.md. */
function unopposedCriteria(): CriteriaOutput {
  return {
    outcome: "criteria",
    criteria: [
      criterion({
        sentence: "`tally --json` prints one JSON object per input, one per line.",
        states_reading: "R1",
        checks: [
          { kind: "leaves_path", argument: "VISION.md" },
          { kind: "leaves_path", argument: "src/format.js" },
        ],
      }),
    ],
    product_call: null,
  };
}

const UPHELD: ChallengeOutput = { outcome: "upheld", objections: [], reason: "Nothing overturns the verdict or its criteria." };

const PRODUCT_CALL: CriteriaOutput = {
  outcome: "needs_product_call",
  criteria: [],
  product_call: {
    reason: "Whether `--json` prints numbers or strings is something users see, and nothing chooses it.",
    options: [
      { reading: "Counts are JSON numbers.", observed_outcome: "`tally --json a` prints {\"words\": 3}." },
      { reading: "Counts are JSON strings.", observed_outcome: "`tally --json a` prints {\"words\": \"3\"}." },
    ],
  },
};

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

/** A forge whose default branch has recently reported the check `test`. */
class ChecksForge extends IntakeForge {
  seenChecks = ["test"];
  override async recentDefaultBranchChecks(): Promise<CommitChecks[]> {
    return [{ sha: "c0ffee", checks: this.seenChecks.map((name) => ({ name, status: "passed", reported: true, url: null })) }];
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: ChecksForge;
  scripted: ScriptedRunner;
  engine: Passes;
  visionSha: string;
  pass(times?: number): Promise<void>;
  ticket(issueNumber?: number): TicketRecord;
  calls(issueNumber?: number): ReturnType<PassSetup["store"]["callsForTicket"]>;
}

async function harness(t: TestContext, options: { pins?: Pin[]; genericCriteria?: GenericCriterion[] } = {}): Promise<Harness> {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const settings = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
  setup.store.saveSettings(repo.id, { ...settings, pins: options.pins ?? [], genericCriteria: options.genericCriteria ?? [G1] }, "Ada");
  const fixture = new FixtureRepo(t);
  fixture.write("VISION.md", VISION).write("src/format.js", "export const format = (n) => String(n);\n");
  const visionSha = fixture.commit("vision");
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
    planners: [deciderPlanner(common), criteriaPlanner(common), boardPlanner({ ...common, notifier, boardOrigin: ORIGIN })],
    modelRuns: new ModelRuns({ runner: scripted, log: setup.log }),
  });
  t.after(() => engine.stop());
  const ticket = (issueNumber = 1) => setup.store.latestTicketForIssue(repo.id, issueNumber)!;
  return {
    setup,
    repo,
    forge,
    scripted,
    engine,
    visionSha,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await until(() => engine.stepsRunning === 0, "every step started has finished");
      }
    },
    ticket,
    calls: (issueNumber = 1) => setup.store.callsForTicket(ticket(issueNumber).id),
  };
}

/** Takes issue 1 in with the scripted verdict, criteria and challenge, and runs passes until it is routed. */
async function decided(h: Harness, verdict: VerdictOutput, criteria?: CriteriaOutput, challenge?: ChallengeOutput): Promise<TicketRecord> {
  h.forge.issues = [issue(1, { title: "Count hyphenated words", body: "Is `a-b` one word or two?" })];
  h.scripted.script("verdict", "1", { output: verdict, facts: { sessionId: "decider-session" } });
  if (criteria) h.scripted.script("criteria", "1", { output: criteria, facts: { sessionId: "criteria-session" } });
  if (challenge) h.scripted.script("challenge", "1", { output: challenge, facts: { sessionId: "challenger-session" } });
  await h.pass(3);
  return h.ticket();
}

function criteriaCall(h: Harness) {
  return h.calls().findLast((call) => call.kind === "criteria")!;
}

function comments(h: Harness): string[] {
  return (h.forge.state.comments["issue:1"] ?? []).map((c) => c.body);
}

// The checks, one by one, as pure functions.

function context(fields: Partial<CriteriaContext> = {}): CriteriaContext {
  return {
    verdict: { ...settled(), pin_matches: [] } as never,
    visionLines: splitVisionLines(VISION),
    fences: [],
    findings: null,
    answered: false,
    seenChecks: ["test"],
    ...fields,
  };
}

function failed(checks: CriteriaChecks): string[] {
  return checks.results.filter((r) => !r.passed).map((r) => r.check);
}

test("criteria that are right on every count pass every check, in order", () => {
  const checks = checkCriteria(settledCriteria(), context());
  assert.equal(checks.passed, true);
  assert.deepEqual(
    checks.results.map((r) => r.check),
    [CRITERIA_CHECKS.count, CRITERIA_CHECKS.sources, CRITERIA_CHECKS.mechanicalChecks, CRITERIA_CHECKS.fences, CRITERIA_CHECKS.readingChosen, CRITERIA_CHECKS.noSlash],
  );
  const fenced = checkCriteria(unopposedCriteria(), context({ verdict: unopposed() as never, fences: ["VISION.md", "src/format.js"] }));
  assert.equal(fenced.passed, true);
  // A vision line is identified with whitespace collapsed (ADR-0003).
  const spaced = settledCriteria(criterion({ id: "C3", sentence: "Words stay as they are.", source: { kind: "vision_line", ref: "A word is a run of  characters between whitespace. " } }));
  assert.equal(checkCriteria(spaced, context()).passed, true);
});

/** Each check, with crafted output that fails it alone. */
const FAILING: [string, CriteriaOutput, Partial<CriteriaContext>, string, RegExp][] = [
  ["no criterion", { outcome: "criteria", criteria: [], product_call: null }, {}, CRITERIA_CHECKS.count, /writes no criterion/],
  [
    "six criteria",
    settledCriteria(criterion({ id: "C3" }), criterion({ id: "C4" }), criterion({ id: "C5" }), criterion({ id: "C6" })),
    {},
    CRITERIA_CHECKS.count,
    /writes 6 criteria, more than 5/,
  ],
  [
    "a vision line that is not in VISION.md",
    settledCriteria(criterion({ id: "C3", sentence: "Words are anything.", source: { kind: "vision_line", ref: "A word is anything between spaces." } })),
    {},
    CRITERIA_CHECKS.sources,
    /C3 is traced to “A word is anything between spaces\.”, which is not word for word a line of VISION\.md/,
  ],
  [
    "findings the ticket was not decided from",
    settledCriteria(criterion({ id: "C3", source: { kind: "findings", ref: "Q1" } })),
    {},
    CRITERIA_CHECKS.sources,
    /C3 is traced to findings, but the ticket was not decided from any/,
  ],
  [
    "a findings entry the findings do not have",
    settledCriteria(criterion({ id: "C3", source: { kind: "findings", ref: "Q2" } })),
    { findings: new Set(["Q1"]) },
    CRITERIA_CHECKS.sources,
    /findings entry “Q2”, which the findings the ticket was decided from do not have/,
  ],
  [
    "an answer that was never given",
    settledCriteria(criterion({ id: "C3", source: { kind: "answer", ref: null } })),
    {},
    CRITERIA_CHECKS.sources,
    /C3 is traced to the owner's answer, but no answer lets this ticket go ahead/,
  ],
  [
    "a check never seen on the default branch",
    settledCriteria(criterion({ id: "C3", checks: [{ kind: "check_passes", argument: "lint" }] })),
    {},
    CRITERIA_CHECKS.mechanicalChecks,
    /C3 names the check “lint”, which has not been seen on the default branch/,
  ],
  [
    "a glob that does not parse",
    settledCriteria(criterion({ id: "C3", checks: [{ kind: "changes_path", argument: "src/[a-" }] })),
    {},
    CRITERIA_CHECKS.mechanicalChecks,
    /C3's glob “src\/\[a-” does not parse: a \[ is never closed/,
  ],
  [
    "a check kind off the closed list",
    settledCriteria(criterion({ id: "C3", checks: [{ kind: "runs_command" as never, argument: "npm test" }] })),
    {},
    CRITERIA_CHECKS.mechanicalChecks,
    /“runs_command”, which is not on the closed list/,
  ],
  [
    "an unopposed ticket missing a fence",
    { ...unopposedCriteria(), criteria: [criterion({ states_reading: "R1", checks: [{ kind: "leaves_path", argument: "VISION.md" }] })] },
    { verdict: unopposed() as never, fences: ["VISION.md", "src/format.js"] },
    CRITERIA_CHECKS.fences,
    /No criterion carries a leaves-path check for “src\/format\.js”/,
  ],
  [
    "an unopposed ticket whose chosen reading no criterion states",
    { ...unopposedCriteria(), criteria: [criterion({ states_reading: null, checks: unopposedCriteria().criteria[0]!.checks })] },
    { verdict: unopposed() as never, fences: ["VISION.md", "src/format.js"] },
    CRITERIA_CHECKS.readingChosen,
    /entail chose R1 among 2 readings, but no criterion traced to the issue states it/,
  ],
  [
    "a criterion stating another reading",
    settledCriteria(criterion({ id: "C3", states_reading: "R2" })),
    {},
    CRITERIA_CHECKS.readingChosen,
    /C3 states “R2”, but the reading the ticket goes ahead with is “R1”/,
  ],
  [
    "a line starting with /",
    settledCriteria(criterion({ id: "C3", sentence: "The issue is resolved.\n/close" })),
    {},
    CRITERIA_CHECKS.noSlash,
    /A line of C3 starts with \//,
  ],
];

test("each check fails crafted output on its own", () => {
  for (const [name, output, fields, check, failure] of FAILING) {
    const checks = checkCriteria(output, context(fields));
    assert.equal(checks.passed, false, name);
    assert.deepEqual(failed(checks), [check], `${name}: only ${check} fails`);
    assert.match(checks.results.find((r) => r.check === check)!.failure!, failure, name);
  }
});

test("a product call must name its open choice, and only it and lines starting with / are checked", () => {
  assert.equal(checkCriteria(PRODUCT_CALL, context()).passed, true);
  const none = checkCriteria({ ...PRODUCT_CALL, product_call: { reason: "x", options: [] } }, context());
  assert.deepEqual(failed(none), [CRITERIA_CHECKS.productCall]);
  const slashed = checkCriteria({ ...PRODUCT_CALL, product_call: { ...PRODUCT_CALL.product_call!, reason: "/label ~bug" } }, context());
  assert.deepEqual(failed(slashed), [CRITERIA_CHECKS.noSlash]);
});

test("a glob parses when it is relative, inside the repo and balanced", () => {
  for (const glob of ["src/format.js", "VISION.md", "src/**/*.{js,ts}", "docs/[a-z]*.md", "a\\[b"]) assert.equal(globProblem(glob), null, glob);
  for (const [glob, problem] of [
    ["", /empty/],
    ["/etc/passwd", /absolute/],
    ["../elsewhere", /outside the repository/],
    ["src/{a,b", /\{ is never closed/],
    ["src/a}", /\} closes no \{/],
    ["src/a\\", /ends in an escape/],
    ["a`b", /backtick/],
  ] as const) {
    assert.match(globProblem(glob) ?? "", problem, glob);
  }
});

test("the fences are every pin's paths and VISION.md's, once each", () => {
  assert.deepEqual(fenceGlobs(judgedPins([FORMAT_PIN, { topic: "docs", paths: ["docs/**", "src/format.js"], keywords: [] }, { topic: "tone", paths: [], keywords: ["tone"] }])), [
    "VISION.md",
    "src/format.js",
    "docs/**",
  ]);
});

// The step, end to end with the scripted runner.

for (const [name, output, fields, check] of FAILING) {
  test(`criteria output failing "${check}" (${name}) is a machine failure, retried, and never clears or raises`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const unopposedCase = fields.verdict !== undefined;
    const h = await harness(t, { pins: unopposedCase ? [FORMAT_PIN] : [] });
    h.forge.issues = [issue(1, { title: "Count hyphenated words" })];
    h.scripted.script("verdict", "1", { output: unopposedCase ? unopposed() : settled() });
    h.scripted.script("criteria", "1", { output }, { output: unopposedCase ? unopposedCriteria() : settledCriteria() });
    h.scripted.script("challenge", "1", { output: UPHELD });
    await h.pass(1);
    await h.engine.runPass();
    await until(() => h.setup.logLines().some((line) => line.event === "model-run-retry" && line.kind === "criteria"), "the invalid criteria wait for their retry");

    const failure = h.setup.logLines().find((line) => line.event === "machine-failure" && line.kind === "criteria")!;
    assert.equal(failure.failure, "no-structured-output");
    // A kind off the closed list is already refused by the schema, before entail's own checks.
    const expected = name === "a check kind off the closed list" ? "does not match the schema" : `the output is invalid: ${check}`;
    assert.ok(String(failure.error).includes(expected), `${String(failure.error)} says ${expected}`);
    assert.equal(h.ticket().state, "deciding");
    assert.deepEqual(h.calls().map((c) => c.kind), ["intake", "verdict"], "nothing is recorded for invalid output");
    assert.equal(h.setup.store.boardItemsForTicket(h.ticket().id).length, 0, "a machine failure never reaches the board");

    t.mock.timers.tick(60_000);
    await until(() => h.engine.stepsRunning === 0, "the retried criteria have finished");
    assert.equal(h.ticket().state, "cleared");
    assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict", "criteria", "criteria", "challenge"], "the challenge runs only after valid criteria");
  });
}

test(`a product call that names no open choice fails "${CRITERIA_CHECKS.productCall}", a machine failure retried until it does`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  h.forge.issues = [issue(1)];
  h.scripted.script("verdict", "1", { output: unopposed() });
  h.scripted.script("criteria", "1", { output: { ...PRODUCT_CALL, product_call: { ...PRODUCT_CALL.product_call!, options: [] } } }, { output: PRODUCT_CALL });
  await h.pass(1);
  await h.engine.runPass();
  await until(() => h.setup.logLines().some((line) => line.event === "model-run-retry" && line.kind === "criteria"), "the invalid product call waits for its retry");
  const failure = h.setup.logLines().find((line) => line.event === "machine-failure" && line.kind === "criteria")!;
  assert.ok(String(failure.error).includes(`the output is invalid: ${CRITERIA_CHECKS.productCall}`));
  assert.deepEqual(h.calls().map((c) => c.kind), ["intake", "verdict"]);

  t.mock.timers.tick(60_000);
  await until(() => h.engine.stepsRunning === 0, "the retried criteria have finished");
  await h.pass(1);
  assert.equal(h.ticket().state, "on-the-board");
  assert.equal(h.setup.store.openBoardItem(h.ticket().id)!.whyRaised, "criteria_product_call");
});

for (const [name, verdict, criteria] of [
  ["settled", settled(), settledCriteria()],
  ["unopposed", unopposed(), unopposedCriteria()],
] as const) {
  test(`the challenge runs once over the ${name} verdict and its criteria together, after both pass their checks`, async (t) => {
    const h = await harness(t, { pins: [FORMAT_PIN] });
    const ticket = await decided(h, verdict, criteria, UPHELD);
    assert.equal(ticket.state, "cleared");

    const [verdictRun, criteriaRun, challengeRun, ...rest] = h.scripted.requests;
    assert.equal(rest.length, 0, "one verdict, one criteria and one challenge run");
    assert.deepEqual([verdictRun!.kind, criteriaRun!.kind, challengeRun!.kind], ["verdict", "criteria", "challenge"]);
    assert.equal(criteriaRun!.promptVersion, CRITERIA_PROMPT_VERSION);
    assert.equal(criteriaRun!.sha, h.visionSha, "the criteria run reads the default branch at the verdict's sha");
    assert.match(criteriaRun!.prompt, /You are entail's criteria writer/);
    assert.match(criteriaRun!.prompt, /"text": "Is `a-b` one word or two\?"/, "its input is the issue");
    assert.match(criteriaRun!.prompt, /## The verdict \(as JSON\)\n\{\n {2}"verdict": "(settled|unopposed)"/, "the verdict");
    assert.match(criteriaRun!.prompt, /tally never reaches the network\./, "the vision");
    assert.match(criteriaRun!.prompt, /"topic": "the output format"/, "the pins");
    assert.match(criteriaRun!.prompt, /"sentence": "The check `test` passes\."/, "and the generic criteria");

    assert.equal(challengeRun!.promptVersion, CHALLENGE_PROMPT_VERSION);
    assert.match(challengeRun!.prompt, /## The proposed verdict/);
    assert.match(challengeRun!.prompt, /## The proposed criteria \(to be tested, as JSON\)/);
    assert.match(challengeRun!.prompt, /"criterion_beyond_source": a criterion that decides something its source does not/);
    assert.ok(challengeRun!.prompt.includes(JSON.stringify(criteria.criteria[0]!.sentence)), "the challenger sees the criteria");

    const verdictCall = h.calls().find((call) => call.kind === "verdict")!;
    assert.equal((verdictCall.checks as VerdictChecks).passed, true);
    assert.equal(verdictCall.challenge, null, "no challenge on the verdict alone");
    assert.deepEqual(verdictCall.modelRuns.map((r) => r.purpose), ["verdict"]);
    const call = criteriaCall(h);
    assert.equal((call.checks as CriteriaChecks).passed, true);
    assert.equal((call.challenge as RecordedChallenge).overturned, false);
    assert.equal((call.challenge as RecordedChallenge).session_id, "challenger-session");
    assert.deepEqual(call.modelRuns.map((r) => [r.purpose, r.sessionId]), [["criteria", "criteria-session"], ["challenge", "challenger-session"]]);

    await h.pass(2);
    assert.equal(h.scripted.requests.length, 3, "a cleared ticket owes no more runs");
  });
}

test("an unopposed ticket's criteria fence every pin's paths and VISION.md, and the clear records no contradiction found, why unopposed and the reading chosen", async (t) => {
  const h = await harness(t, { pins: [FORMAT_PIN] });
  const ticket = await decided(h, unopposed(), unopposedCriteria(), UPHELD);
  assert.equal(ticket.state, "cleared");

  const criteriaRun = h.scripted.requests.find((r) => r.kind === "criteria")!;
  assert.match(criteriaRun.prompt, /put each of these leaves_path checks on a criterion, with the glob exactly as given: "VISION\.md", "src\/format\.js"/);
  assert.match(criteriaRun.prompt, /entail chose between readings, so one criterion traced to the issue states the reading chosen, R1/);

  const call = criteriaCall(h);
  assert.equal(call.noContradictionFound, true);
  assert.equal(call.citation, null);
  const detail = call.detail as CriteriaDetail;
  assert.deepEqual(detail.fences, ["VISION.md", "src/format.js"]);
  const fences = detail.criteria.flatMap((c) => c.checks).filter((check) => check.kind === "leaves_path").map((check) => check.argument);
  assert.deepEqual(fences.sort(), ["VISION.md", "src/format.js"]);
  assert.equal(detail.why_unopposed, "No vision line speaks to machine-readable output.");
  assert.deepEqual(detail.reading_chosen, unopposed().readings[0]);
  assert.match(call.reason, /^Cleared: no contradiction found\. No vision line speaks to machine-readable output\.$/);

  const [body] = comments(h);
  assert.match(body!, /#### Why cleared\n\nNo contradiction found\. No vision line speaks to machine-readable output\.\n\nReading chosen: Print one JSON object per input, one per line\./);
  assert.match(body!, /- Mechanical check: the PR changes no file matching `VISION\.md`\./);
  assert.match(body!, /- Mechanical check: the PR changes no file matching `src\/format\.js`\./);
});

test("a cleared ticket has exactly one intake comment in the specified shape, and the entail:cleared label", async (t) => {
  const h = await harness(t);
  const ticket = await decided(h, settled(), settledCriteria(), UPHELD);
  assert.equal(ticket.state, "cleared");
  await h.pass(2);

  const bodies = comments(h);
  assert.equal(bodies.length, 1, "exactly one intake comment");
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL]);
  assert.equal(h.forge.state.sends.addLabel, 1);
  const body = bodies[0]!;
  assertCommentRules(body, "Ada", ticket.id);
  const permalink = `https://github.com/acme/tally/blob/${h.visionSha}/VISION.md#L8`;
  const sha = h.visionSha.slice(0, 7);
  assert.equal(
    body,
    [
      "Speaking from Ada's entail:",
      "",
      "### Vision check",
      "",
      `Only the lines of VISION.md that bear on this issue are listed, quoted from VISION.md at \`${sha}\`.`,
      "",
      `> ${WORD_LINE}`,
      "",
      `Matches · [VISION.md line 8 at \`${sha}\`](${permalink})`,
      "",
      "### What happens next",
      "",
      "entail cleared this issue. A PR that closes it must meet every criterion below and every generic criterion of this repo.",
      "",
      "#### Criteria",
      "",
      "- **C1** `tally` counts `a-b` as one word.",
      "  - No mechanical check: it is graded from the PR's evidence.",
      "- **C2** Words stay runs of characters between whitespace.",
      "  - Mechanical check: the check `test` passes.",
      "",
      "#### Generic criteria",
      "",
      "- **G1** The check `test` passes.",
      "  - Mechanical check: the check `test` passes.",
      "",
      "#### Why cleared",
      "",
      `The vision settles this issue. Citation: [VISION.md line 8 at \`${sha}\`](${permalink}).`,
      "",
      "Label: `entail:cleared`. Any executor may pick this issue up.",
      "",
      EXECUTOR_LINE,
      "",
      `<!-- entail ticket ${ticket.id} -->`,
    ].join("\n"),
  );

  const call = criteriaCall(h);
  assert.equal(call.stateChange?.to, "cleared");
  assert.deepEqual(call.citation, { visionSha: h.visionSha, lines: [WORD_LINE] });
  assert.equal(call.noContradictionFound, false);
  assert.equal(call.postedComments.length, 1);
  assert.deepEqual(call.inputs, {
    issueTitle: "Count hyphenated words",
    issueBody: "Is `a-b` one word or two?",
    visionSha: h.visionSha,
    pins: judgedPins([]),
    settingsVersionId: h.setup.store.latestSettings(h.repo.id)!.id,
    prHeadSha: null,
  });
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 0, "going ahead needs no owner sign-off");
});

test("criteria and generic criteria are frozen with the ticket; editing the comment or the settings changes nothing", async (t) => {
  const h = await harness(t);
  const ticket = await decided(h, settled(), settledCriteria(), UPHELD);
  const frozen = criteriaInForce(h.calls())!;
  assert.equal(frozen.version, 1);
  assert.deepEqual(frozen.criteria.map((c) => [c.id, c.sentence, c.source.kind]), [
    ["C1", "`tally` counts `a-b` as one word.", "issue"],
    ["C2", "Words stay runs of characters between whitespace.", "vision_line"],
  ]);
  assert.deepEqual(frozen.genericCriteria, [G1]);
  const settingsVersion = h.setup.store.latestSettings(h.repo.id)!;
  assert.equal(frozen.settingsVersionId, settingsVersion.id);

  // Someone edits entail's comment on the forge, and the owner changes the generic criteria.
  const posted = h.forge.state.comments["issue:1"]![0]!;
  posted.body = posted.body.replace("one word", "two words");
  h.setup.store.saveSettings(h.repo.id, { ...(settingsVersion.settings as RepoSettings), genericCriteria: [] }, "Ada");
  const callsBefore = h.calls().length;
  await h.pass(2);

  assert.deepEqual(criteriaInForce(h.calls()), frozen, "the records, never the comment, hold the criteria");
  assert.equal(h.calls().length, callsBefore, "no new call");
  assert.equal(h.ticket().state, "cleared");
  assert.equal(ticket.id, h.ticket().id);
});

test("a criterion that needs a product call raises a board item with the open choice as options, without a challenge", async (t) => {
  const h = await harness(t);
  const ticket = await decided(h, unopposed(), PRODUCT_CALL);
  assert.equal(ticket.state, "on-the-board");
  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict", "criteria"], "nothing is cleared, so nothing is challenged");

  const call = criteriaCall(h);
  assert.equal(call.stateChange, null);
  assert.equal((call.detail as CriteriaDetail).outcome, "needs_product_call");
  assert.equal((call.detail as CriteriaDetail).version, null, "no criteria version is published");
  assert.equal(criteriaInForce(h.calls()), null);
  assert.match(call.reason, /^Writing the criteria needs a product call: Whether `--json` prints numbers or strings/);

  const item = h.setup.store.openBoardItem(ticket.id)!;
  assert.equal(item.whyRaised, "criteria_product_call");
  const snapshot = item.snapshot as BoardItemSnapshot;
  assert.match(snapshot.why.text, /^Writing the criteria needs a product call: Whether `--json` prints numbers or strings/);
  assert.equal(snapshot.why.productCall, PRODUCT_CALL.product_call!.reason);
  assert.deepEqual(
    snapshot.form.options.map((o) => [o.title, o.outcome]),
    PRODUCT_CALL.product_call!.options.map((o) => [o.reading, o.observed_outcome]),
    "the open choice becomes the options",
  );
  const raise = h.calls().at(-1)!;
  assert.equal(raise.kind, "raise");
  assert.equal((raise.detail as { basedOnCallId: number }).basedOnCallId, call.id);
  assert.deepEqual(h.forge.state.labels[1] ?? [], [], "no label");
  assert.equal(comments(h).length, 1, "one intake comment, linking the board");
  assert.ok(!comments(h)[0]!.includes("numbers or strings"), "with no question text");
});

test("a challenge that finds a criterion deciding what its source does not sends the ticket to the board", async (t) => {
  const h = await harness(t);
  const objection: ChallengeOutput = {
    outcome: "overturned",
    objections: [
      {
        kind: "criterion_beyond_source",
        objection: "Nothing in the issue says hyphenated words count once",
        lines: [],
        pin: null,
        reading: null,
        criterion: "C1",
      },
    ],
    reason: "C1 decides something the issue does not.",
  };
  const ticket = await decided(h, settled(), settledCriteria(), objection);
  assert.equal(ticket.state, "on-the-board");

  const call = criteriaCall(h);
  assert.equal(call.stateChange, null);
  assert.equal((call.challenge as RecordedChallenge).overturned, true);
  assert.equal(criteriaInForce(h.calls()), null, "criteria the challenge overturned are never published");
  const item = h.setup.store.openBoardItem(ticket.id)!;
  assert.equal(item.whyRaised, "challenge");
  const snapshot = item.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.objection, "C1: Nothing in the issue says hyphenated words count once.");
  assert.deepEqual(snapshot.form.options.map((o) => o.id), ["R1", "R2"]);
  assert.deepEqual(h.forge.state.labels[1] ?? [], []);
});

test("a challenge that misses no reading but finds a touched pin names it on the board", async (t) => {
  const h = await harness(t, { pins: [FORMAT_PIN] });
  const ticket = await decided(h, unopposed(), unopposedCriteria(), {
    outcome: "upheld",
    objections: [{ kind: "touched_pin", objection: "JSON output changes the output format.", lines: [], pin: "the output format", reading: null, criterion: null }],
    reason: "Mostly fine.",
  });
  assert.equal(ticket.state, "on-the-board", "any objection overturns whatever the outcome says");
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.deepEqual(snapshot.why.pins, [{ pin: "the output format", why: "JSON output changes the output format" }]);
});

test("a machine failure of the challenge leaves the ticket deciding and is retried, never raised", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  h.forge.issues = [issue(1)];
  h.scripted.script("verdict", "1", { output: settled() });
  h.scripted.script("criteria", "1", { output: settledCriteria() });
  h.scripted.script("challenge", "1", { failure: { kind: "refusal", message: "the model declined" } }, { output: UPHELD });
  await h.pass(1);
  await h.engine.runPass();
  await until(() => h.setup.logLines().some((line) => line.event === "model-run-retry" && line.kind === "challenge"), "the failed challenge waits for its retry");
  assert.equal(h.ticket().state, "deciding");
  assert.deepEqual(h.calls().map((c) => c.kind), ["intake", "verdict"], "nothing is recorded while the challenge fails");

  t.mock.timers.tick(60_000);
  await until(() => h.engine.stepsRunning === 0, "the retried challenge has finished");
  assert.equal(h.ticket().state, "cleared");
  assert.equal(h.setup.store.boardItemsForTicket(h.ticket().id).length, 0, "a machine failure never reaches the board");
  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict", "criteria", "challenge", "challenge"], "only the challenge is retried");
});

test("a verdict that failed its checks is never given criteria", async (t) => {
  const h = await harness(t, { pins: [FORMAT_PIN] });
  const ticket = await decided(h, unopposed({ pins_touched: [{ pin: "the output format", why: "it prints JSON" }] }));
  assert.equal(ticket.state, "on-the-board");
  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"]);
});

test("a clear whose comment and label failed to post is settled on the next start, once each", async (t) => {
  const h = await harness(t);
  const post = h.forge.postComment.bind(h.forge);
  h.forge.postComment = async () => {
    throw new Error("the forge did not answer");
  };
  const ticket = await decided(h, settled(), settledCriteria(), UPHELD);
  assert.equal(ticket.state, "cleared", "the clear is recorded though the comment failed");
  assert.equal(h.forge.state.sends.comment, 0);
  assert.equal(h.forge.state.sends.addLabel, 0, "the label waits behind the comment");

  h.forge.postComment = post;
  const settledWrites = await settleUnconfirmedWrites(h.setup.store, () => h.forge);
  assert.equal(settledWrites.length, 2);
  assert.equal(comments(h).length, 1);
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL]);
  await h.pass(2);
  assert.equal(comments(h).length, 1, "not posted again");
  assert.equal(h.forge.state.sends.addLabel, 1);
});
