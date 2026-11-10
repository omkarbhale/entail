import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { boardPlanner, type BoardItemSnapshot } from "../src/board-item.ts";
import type { ChallengeOutput } from "../src/challenge.ts";
import { checkClose, closeCommentText, findEvidence, type CloseChecks } from "../src/close-at-intake.ts";
import { assertCommentRules, composeComment } from "../src/comment-rules.ts";
import { checkCriteria, criteriaPlanner, criteriaPrompt, type CriteriaDetail } from "../src/criteria.ts";
import { deciderPlanner, type RecordedVerdict } from "../src/decider.ts";
import type { CommitChecks, ForgeComment } from "../src/forge/forge.ts";
import { EXECUTOR_LINE, INVESTIGATE_LABEL, intakeCommentText, investigatingNextText } from "../src/intake-comment.ts";
import {
  checkInvestigation,
  findingsIds,
  findingsPlanner,
  INVESTIGATION_CHECKS,
  parseFindings,
  questionsOf,
  type FindingsDetail,
  type InvestigationChecks,
} from "../src/investigation.ts";
import { Mirror } from "../src/mirror.ts";
import type { CriteriaOutput, VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import type { RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import { INVESTIGATED_ONCE_CHECK, type VerdictChecks } from "../src/verdict-checks.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { actor, IntakeForge, issue, OWNER_ID, passSetup, type PassSetup } from "./pass-fixture.ts";

const VISION = `# tally

tally counts the words of text files.

## Rules

tally never reaches the network.
A word is a run of characters between whitespace.
`;

const WORD_LINE = "A word is a run of characters between whitespace.";
const ORIGIN = "http://127.0.0.1:7419";
const QUESTIONS = ["Can the overcount be reproduced, and on what input?", "What in the code causes it?"];

/** A verdict output with every field the schema asks for: an investigation by default. */
function verdict(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return {
    size: { value: "fits", reason: "One report." },
    readings: [],
    pins_touched: [],
    vision_check: [{ line: WORD_LINE, mark: "does_not_settle" }],
    verdict: "investigate",
    citations: [],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: null,
    open_readings: [],
    close_evidence: [],
    questions: QUESTIONS,
    reason: "The report gives no reproduction, so whether it is real is unknown.",
    ...fields,
  };
}

/** The verdict after findings: the vision settles the fix the findings make known. */
function settledAfterFindings(): VerdictOutput {
  return verdict({
    verdict: "settled",
    questions: [],
    readings: [{ id: "R1", reading: "A leading space is not a word.", observed_outcome: "`echo ' a' | tally` prints 1." }],
    vision_check: [{ line: WORD_LINE, mark: "matches" }],
    citations: [{ lines: [WORD_LINE], reading: "R1" }],
    reason: "The findings show a leading space counted as a word, which the vision rules out.",
  });
}

const CRITERIA: CriteriaOutput = {
  outcome: "criteria",
  criteria: [
    {
      id: "C1",
      sentence: "Text that starts with whitespace is counted without an extra word.",
      source: { kind: "findings", ref: "Q2" },
      checks: [{ kind: "check_passes", argument: "test" }],
      states_reading: null,
    },
    { id: "C2", sentence: WORD_LINE, source: { kind: "vision_line", ref: WORD_LINE }, checks: [], states_reading: null },
  ],
  product_call: null,
};

const UPHELD: ChallengeOutput = { outcome: "upheld", objections: [], reason: "Nothing overturns it." };

const FINDINGS = `## entail findings

Q1: Reproduced: \`echo ' a' | tally\` prints 2.
Q2: A leading space counts as a word: the split yields an empty first field.`;

function recordedVerdict(fields: Partial<VerdictOutput> = {}): RecordedVerdict {
  return { ...verdict(fields), model: "m", session_id: null, vision_sha: "f".repeat(40), duration_ms: 1, estimated_cost_usd: null, usage: null, pin_matches: [] };
}

function findingsDetail(entries: FindingsDetail["entries"], unknown: string[] = []): FindingsDetail {
  return {
    investigationCallId: 1,
    comment: { id: 77, url: "https://github.com/acme/tally/issues/5#issuecomment-77", createdAt: "2026-11-08T13:00:00.000Z", author: actor(2002), body: FINDINGS },
    questions: questionsOf({ questions: QUESTIONS }),
    entries,
    unknown,
  };
}

// The checks on a chosen investigation.

test("a chosen investigation passes its checks with at least one question and no line starting with /", () => {
  const passed = checkInvestigation(verdict());
  assert.deepEqual(passed, {
    passed: true,
    results: [
      { check: INVESTIGATION_CHECKS.atLeastOneQuestion, passed: true, failure: null },
      { check: INVESTIGATION_CHECKS.noSlash, passed: true, failure: null },
    ],
  } satisfies InvestigationChecks);

  const none = checkInvestigation(verdict({ questions: [] }));
  assert.equal(none.passed, false);
  assert.equal(none.results[0]!.failure, "The investigation names no question.");
  assert.equal(checkInvestigation(verdict({ questions: ["  ", "\n"] })).results[0]!.passed, false, "blank questions are no questions");

  const slashed = checkInvestigation(verdict({ questions: ["Does it reproduce?", "What causes it?\n /close"] }));
  assert.equal(slashed.passed, false);
  assert.equal(slashed.results[1]!.failure, "A line of Q2 starts with /.");
  assert.throws(() => checkInvestigation(verdict({ verdict: "settled" })), /only an investigate verdict/);
});

test("the questions are numbered Q1…Qn by position, each on one line", () => {
  assert.deepEqual(questionsOf({ questions: ["Does it\n reproduce?", " ", "What causes it?"] }), [
    { id: "Q1", question: "Does it reproduce?" },
    { id: "Q2", question: "What causes it?" },
  ]);
});

test("the investigate intake comment lists the questions, then the label, and ends with the executor line", () => {
  const text = intakeCommentText({
    visionCheck: { commit: "a".repeat(40), lines: [], unquotable: [] },
    next: investigatingNextText(questionsOf({ questions: [...QUESTIONS, "Is <!-- this --> hidden?"] })),
  });
  assert.match(text, /^### Vision check$/m);
  assert.match(text, /^#### Questions$/m);
  assert.match(text, /^- \*\*Q1\*\* Can the overcount be reproduced, and on what input\?$/m);
  assert.match(text, /^- \*\*Q2\*\* What in the code causes it\?$/m);
  assert.match(text, /^- \*\*Q3\*\* Is &lt;!-- this --> hidden\?$/m, "a question cannot open a hidden marker");
  assert.ok(text.indexOf("Q3") < text.indexOf(`\`${INVESTIGATE_LABEL}\``), "the questions, then the label");
  assert.ok(text.trimEnd().endsWith(EXECUTOR_LINE));
  assertCommentRules(composeComment("Ada", 4, text), "Ada", 4);
});

// Reading a findings comment.

test("a findings comment is read by its heading, one entry per question id", () => {
  assert.deepEqual(parseFindings(FINDINGS), [
    { id: "Q1", text: "Reproduced: `echo ' a' | tally` prints 2." },
    { id: "Q2", text: "A leading space counts as a word: the split yields an empty first field." },
  ]);
  for (const heading of ["**entail findings**", "Entail Findings:", "### entail findings", "entail findings"]) {
    assert.deepEqual(parseFindings(`${heading}\nQ1: yes`), [{ id: "Q1", text: "yes" }], heading);
  }
  assert.equal(parseFindings("Report findings in an `entail findings` comment.\nQ1: yes"), null, "a mention is not the heading");
  assert.equal(parseFindings("Q1: yes"), null);
});

test("findings entries take list markup, run on over following lines, keep the first of a repeated id and stop at the next heading", () => {
  const body = [
    "Thanks for the report.",
    "",
    "## entail findings",
    "",
    "- **Q1** — Reproduced on `echo ' a'`.",
    "  It prints 2 instead of 1.",
    "1. q2: The split on whitespace",
    "keeps an empty first field.",
    "Q1: a second answer is ignored",
    "**Q3:**",
    "**Q4:** `tally -` reads standard input.",
    "",
    "## Notes",
    "Q5: not part of the findings",
  ].join("\n");
  assert.deepEqual(parseFindings(body), [
    { id: "Q1", text: "Reproduced on `echo ' a'`.\nIt prints 2 instead of 1." },
    { id: "Q2", text: "The split on whitespace\nkeeps an empty first field." },
    { id: "Q4", text: "`tally -` reads standard input." },
  ]);
});

test("lines in a code fence neither open the findings nor start an entry", () => {
  const body = ["```", "## entail findings", "Q1: an example", "```", "", "## entail findings", "Q1: Reproduced:", "```", "Q2: printed by tally", "```"].join("\n");
  assert.deepEqual(parseFindings(body), [{ id: "Q1", text: "Reproduced:\n```\nQ2: printed by tally\n```" }]);
  assert.equal(parseFindings("```\nentail findings\nQ1: x\n```"), null);
});

// Findings as a source and as close evidence.

test("a criterion may cite a findings entry by question id, and the source check verifies the entry exists", () => {
  const findings = findingsDetail([{ id: "Q2", text: "A leading space counts as a word." }], ["Q1"]);
  const context = {
    verdict: recordedVerdict({ verdict: "settled", readings: [{ id: "R1", reading: "r", observed_outcome: "o" }], citations: [{ lines: [WORD_LINE], reading: "R1" }] }),
    visionLines: [],
    fences: [],
    findings: findingsIds(findings),
    answered: false,
    seenChecks: ["test"],
  };
  const cites = (ref: string): CriteriaOutput => ({ ...CRITERIA, criteria: [{ ...CRITERIA.criteria[0]!, source: { kind: "findings", ref } }] });
  assert.equal(checkCriteria(cites("Q2"), context).passed, true);
  const unknown = checkCriteria(cites("Q1"), context);
  assert.equal(unknown.passed, false, "Q1 has no entry, so it stays unknown and cannot be a source");
  assert.match(unknown.results[1]!.failure!, /findings entry “Q1”, which the findings the ticket was decided from do not have/);
});

test("an answered ticket with findings offers all four sources and shows the findings in the criteria prompt", () => {
  const findings = findingsDetail([{ id: "Q2", text: "A leading space counts as a word." }], ["Q1"]);
  const input = {
    visionSha: "f".repeat(40),
    visionLines: [],
    pins: [],
    request: { title: "Leading space", body: "b", parts: [] },
    verdict: recordedVerdict({ verdict: "needs_the_owner" }),
    genericCriteria: [],
    fences: [],
    seenChecks: ["test"],
    answers: [{ asked: "Split on punctuation?", answer: "No", observed_outcome: null, note: null }],
  };
  const withFindings = criteriaPrompt({ ...input, findings });
  assert.match(withFindings, /"answer" \(ref null\)/);
  assert.match(withFindings, /"findings" with the question id of a findings entry as ref \(one of "Q2"\)/);
  assert.match(withFindings, /The investigation's findings/);
  assert.match(withFindings, /A leading space counts as a word/);
  assert.match(withFindings, /"states_reading" null/);
  const without = criteriaPrompt(input);
  assert.doesNotMatch(without, /The investigation's findings/);
  assert.match(without, /no criterion is traced to "findings"/);
  const context = { verdict: input.verdict, visionLines: [], fences: [], findings: findingsIds(findings), answered: true, seenChecks: ["test"] };
  const cites: CriteriaOutput = { ...CRITERIA, criteria: [{ ...CRITERIA.criteria[0]!, source: { kind: "findings", ref: "Q2" } }] };
  assert.equal(checkCriteria(cites, context).passed, true);
});

test("a close may cite a findings entry, which must be in the findings the ticket was decided from", async () => {
  const findings = findingsDetail([{ id: "Q1", text: "It does not reproduce on any input." }], ["Q2"]);
  const input = { forge: new IntakeForge(), git: null as never, repo: { forge: "github" as const, host: "github.com", path: "acme/tally" }, head: "h", issueNumber: 5, ticketState: () => null };
  const found = await findEvidence({ ...input, findings }, [
    { kind: "findings", ref: "q1", why: "It cannot be reproduced." },
    { kind: "findings", ref: "Q2", why: "No cause." },
  ]);
  assert.deepEqual(found[0], {
    kind: "findings",
    ref: "q1",
    why: "It cannot be reproduced.",
    entry: { id: "Q1", question: QUESTIONS[0], text: "It does not reproduce on any input.", url: findings.comment.url },
    missing: null,
  });
  assert.equal(found[1]!.missing, "The findings the ticket was decided from have no entry “Q2”.");
  const [never] = await findEvidence({ ...input, findings: null }, [{ kind: "findings", ref: "Q1", why: "x" }]);
  assert.equal(never!.missing, "It cites findings entry “Q1”, but the ticket was not decided from any findings.");

  const checks = checkClose(recordedVerdict({ verdict: "close", close_evidence: [{ kind: "findings", ref: "q1", why: "x" }] }), [found[0]!]);
  assert.equal(checks.passed, true, "findings evidence rests on more than the vision");
  const text = closeCommentText([found[0]!], "It cannot be reproduced.");
  assert.match(text, /^The findings of this issue's investigation show that nothing is to be done for it, so entail has closed it\.$/m);
  assert.match(text, /^- The \[findings\]\(https:\/\/github\.com\/acme\/tally\/issues\/5#issuecomment-77\) for Q1 show there is nothing to fix: It cannot be reproduced\.$/m);
  assert.doesNotMatch(text, /does not reproduce on any input/, "the findings' own text is linked, not quoted");
});

// End to end through the passes.

/** A forge whose issue comments are entail's own and the ones a test posts, oldest first. */
class InvestigationForge extends IntakeForge {
  override async comments(target: "issue" | "pr", number: number): Promise<ForgeComment[]> {
    const own = (this.state.comments[`${target}:${number}`] ?? []).map((c) => ({
      id: c.id,
      body: c.body,
      author: actor(OWNER_ID),
      createdAt: c.createdAt,
      url: `https://github.com/acme/tally/issues/${number}#issuecomment-${c.id}`,
    }));
    return [...own, ...(this.issueComments.get(number) ?? [])].sort((a, b) => a.id - b.id);
  }

  /** Posts a comment on an issue as someone else, after everything posted so far. */
  say(number: number, author: number, body: string): ForgeComment {
    const id = this.state.nextId++;
    const posted = { id, body, author: actor(author), createdAt: "2026-11-08T13:00:00.000Z", url: `https://github.com/acme/tally/issues/${number}#issuecomment-${id}` };
    this.issueComments.set(number, [...(this.issueComments.get(number) ?? []), posted]);
    return posted;
  }

  override async recentDefaultBranchChecks(): Promise<CommitChecks[]> {
    return [{ sha: "c0ffee", checks: [{ name: "test", status: "passed", reported: true, url: null }] }];
  }
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
  forge: InvestigationForge;
  scripted: ScriptedRunner;
  engine: Passes;
  pass(times?: number): Promise<void>;
  ticket(): TicketRecord;
  calls(): ReturnType<PassSetup["store"]["callsForTicket"]>;
  settings(fields: Partial<RepoSettings>): void;
}

async function harness(t: TestContext): Promise<Harness> {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const fixture = new FixtureRepo(t);
  fixture.write("VISION.md", VISION).write("src/count.js", "export const count = (s) => s.split(/\\s+/).length;\n");
  fixture.commit("vision");
  fixture.push();
  const mirror = await Mirror.open({
    dataDirectory: setup.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: repo.projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  const forge = new InvestigationForge();
  forge.issues = [issue(5, { title: "Word counts are sometimes one too high", body: "No reproduction, sorry." })];
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
      deciderPlanner(common),
      criteriaPlanner(common),
      boardPlanner({ ...common, notifier, boardOrigin: ORIGIN }),
      findingsPlanner({ store: setup.store, log: setup.log }),
    ],
    modelRuns: new ModelRuns({ runner: scripted, log: setup.log }),
  });
  t.after(() => engine.stop());
  const ticket = () => setup.store.latestTicketForIssue(repo.id, 5)!;
  return {
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
    settings(fields) {
      const current = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
      setup.store.saveSettings(repo.id, { ...current, ...fields }, "Ada");
    },
  };
}

/** Runs passes until issue 5 is investigating, with the investigate verdict scripted. */
async function investigating(h: Harness): Promise<void> {
  h.scripted.script("verdict", "1", { output: verdict() });
  await h.pass();
  assert.equal(h.ticket().state, "investigating");
}

function issueComments(h: Harness): string[] {
  return (h.forge.state.comments["issue:5"] ?? []).map((c) => c.body);
}

test("choosing investigation is a logged call with checks only: entail adds entail:investigate and posts the questions", async (t) => {
  const h = await harness(t);
  await investigating(h);

  const prompt = h.scripted.requests[0]!.prompt;
  assert.match(prompt, /2\. Unknown problem\./);
  assert.doesNotMatch(prompt, /investigation's findings/, "no findings yet");

  const calls = h.calls();
  assert.deepEqual(calls.map((c) => c.kind), ["intake", "investigation"]);
  const chosen = calls[1]!;
  assert.deepEqual(chosen.stateChange, { from: "deciding", to: "investigating" });
  assert.equal((chosen.checks as InvestigationChecks).passed, true);
  assert.equal(chosen.challenge, null, "no challenge");
  assert.deepEqual(chosen.modelRuns.map((r) => r.purpose), ["verdict"]);
  assert.match(chosen.reason, /^To be investigated: The report gives no reproduction/);
  assert.equal(chosen.inputs?.issueTitle, "Word counts are sometimes one too high");

  const [body] = issueComments(h);
  assertCommentRules(body!, "Ada", h.ticket().id);
  assert.match(body!, /^- \*\*Q1\*\* Can the overcount be reproduced, and on what input\?$/m);
  assert.match(body!, /^- \*\*Q2\*\* What in the code causes it\?$/m);
  assert.match(body!, /Does not settle · \[VISION\.md line 8/, "the first section is the vision check");
  assert.ok(body!.includes(EXECUTOR_LINE));
  assert.deepEqual(h.forge.state.labels[5], [INVESTIGATE_LABEL]);
  assert.equal(chosen.postedComments.length, 1);

  await h.pass(2);
  assert.equal(h.ticket().state, "investigating", "it waits for findings");
  assert.equal(h.scripted.requests.length, 1, "no model runs while it waits");
});

test("an investigation naming no question is invalid output, retried, and nothing is recorded until it is valid", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  h.scripted.script("verdict", "1", { output: verdict({ questions: [] }) }, { output: verdict() });
  await h.engine.runPass();
  await until(() => h.setup.logLines().some((line) => line.event === "model-run-retry" && line.kind === "verdict"), "the invalid investigation waits for its retry");
  const failure = h.setup.logLines().find((line) => line.event === "machine-failure" && line.kind === "verdict")!;
  assert.ok(String(failure.error).includes(`the output is invalid: ${INVESTIGATION_CHECKS.atLeastOneQuestion}`));
  assert.deepEqual(h.calls().map((c) => c.kind), ["intake"]);

  t.mock.timers.tick(60_000);
  await until(() => h.engine.stepsRunning === 0, "the retried verdict has finished");
  assert.equal(h.ticket().state, "investigating");
});

test("the first findings comment after the investigate comment decides the ticket again, which is cleared with criteria citing it", async (t) => {
  const h = await harness(t);
  // Findings posted before the investigation are not for it.
  h.forge.say(5, 2002, "## entail findings\n\nQ1: too early");
  await investigating(h);
  h.forge.say(5, 2002, "I am looking into this.");
  const counted = h.forge.say(5, 2002, FINDINGS);
  h.forge.say(5, 3003, "## entail findings\n\nQ1: a later report is ignored");

  h.scripted.script("verdict", "1", { output: settledAfterFindings() });
  h.scripted.script("criteria", "1", { output: CRITERIA });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass();

  const found = h.calls().find((c) => c.kind === "findings")!;
  assert.deepEqual(found.stateChange, { from: "investigating", to: "deciding" });
  const detail = found.detail as FindingsDetail;
  assert.equal(detail.comment.id, counted.id);
  assert.deepEqual(detail.entries.map((e) => e.id), ["Q1", "Q2"]);
  assert.deepEqual(detail.unknown, []);
  assert.match(found.reason, /^Findings arrived from @user2002, with entries for Q1, Q2\. The ticket is decided again\.$/);
  assert.deepEqual(h.forge.state.labels[5], [], "entail:investigate is removed when the ticket leaves investigating");

  await h.pass(2);
  assert.equal(h.ticket().state, "cleared");
  const [verdictRun, criteriaRun, challengeRun] = h.scripted.requests.slice(1);
  assert.match(verdictRun!.prompt, /2\. Findings\./);
  assert.match(verdictRun!.prompt, /## The investigation's findings \(untrusted issue text/);
  assert.match(verdictRun!.prompt, /"entry": "A leading space counts as a word: the split yields an empty first field\."/);
  const shown = verdictRun!.prompt.slice(verdictRun!.prompt.indexOf("## The investigation's findings"), verdictRun!.prompt.indexOf("## The request"));
  assert.doesNotMatch(shown, /too early|a later report is ignored/, "only the counted findings are shown as findings");
  assert.match(criteriaRun!.prompt, /"findings" with the question id of a findings entry as ref \(one of "Q1", "Q2"\)/);
  assert.match(challengeRun!.prompt, /## The investigation's findings/);

  const criteria = h.calls().findLast((c) => c.kind === "criteria")!.detail as CriteriaDetail;
  assert.deepEqual(criteria.criteria[0]!.source, { kind: "findings", ref: "Q2" });
  assert.deepEqual(h.forge.state.labels[5], ["entail:cleared"]);
  const intake = issueComments(h).at(-1)!;
  assert.match(intake, /This replaces \[entail's earlier intake comment\]/, "the clear names the investigate comment it replaces");
  assert.equal(h.calls().filter((c) => c.kind === "findings").length, 1, "later findings comments are ignored");
});

test("findings showing nothing to fix close the issue through the close-at-intake checks and challenge, and the ticket is cancelled", async (t) => {
  const h = await harness(t);
  await investigating(h);
  h.forge.say(5, 2002, "## entail findings\n\nQ1: It does not reproduce on any input.\nQ2: Nothing; the count is right.");
  h.scripted.script("verdict", "1", {
    output: verdict({
      verdict: "close",
      questions: [],
      readings: [{ id: "R1", reading: "Counts are one too high.", observed_outcome: "Counts drop by one." }],
      close_evidence: [{ kind: "findings", ref: "Q1", why: "It cannot be reproduced." }],
      reason: "The findings show the report cannot be reproduced.",
    }),
  });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(2);

  const ticket = h.ticket();
  assert.equal(ticket.state, "cancelled");
  const closed = h.calls().at(-1)!;
  assert.equal(closed.kind, "close-at-intake");
  assert.equal((closed.checks as CloseChecks).passed, true);
  assert.match(closed.modelRuns[1]!.input, /the findings of the issue's investigation show there is nothing to fix/);
  const body = issueComments(h).at(-1)!;
  assert.match(body, /The findings of this issue's investigation show that nothing is to be done for it/);
  assert.match(body, /- The \[findings\]\(https:\/\/github\.com\/acme\/tally\/issues\/5#issuecomment-\d+\) for Q1 show there is nothing to fix: It cannot be reproduced\./);
  assert.deepEqual(h.forge.state.closed, { 5: "not-planned" });
  assert.deepEqual(h.forge.state.labels[5], []);
});

test("findings that leave the problem unknown raise the ticket to the board; a second investigation is never chosen", async (t) => {
  const h = await harness(t);
  await investigating(h);
  h.forge.say(5, 2002, "## entail findings\n\nQ1: It reproduces only sometimes.");
  h.scripted.script("verdict", "1", { output: verdict({ questions: ["What in the code causes it?"] }) });
  await h.pass(3);

  const ticket = h.ticket();
  assert.equal(ticket.state, "on-the-board");
  const found = h.calls().find((c) => c.kind === "findings")!;
  assert.deepEqual((found.detail as FindingsDetail).unknown, ["Q2"], "a question with no entry stays unknown");
  assert.match(found.reason, /Q2 stays unknown/);
  const again = h.calls().findLast((c) => c.kind === "verdict")!;
  const checks = again.checks as VerdictChecks;
  assert.equal(checks.passed, false);
  assert.equal(checks.results[0]!.check, INVESTIGATED_ONCE_CHECK);
  assert.match(checks.results[0]!.failure!, /Q2 has no entry, so it stays unknown\. Still unknown: “What in the code causes it\?”\./);
  assert.equal(h.calls().filter((c) => c.kind === "investigation").length, 1, "investigated once");
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.kind, "failed_check");
  assert.match(snapshot.why.text, /investigates a ticket at most once, and the findings leave the problem unknown/);
  assert.deepEqual(h.forge.state.labels[5], ["entail:raised"], "entail:investigate stays off on the board, and entail:raised is on");
});

test("under owner plus listed executors, another account's findings are not used and get one comment, once", async (t) => {
  const h = await harness(t);
  h.settings({ whoCounts: "owner-and-listed", executors: [actor(3003)] });
  await investigating(h);
  h.forge.say(5, 2002, FINDINGS);
  await h.pass();
  assert.equal(h.ticket().state, "investigating");
  const excluded = issueComments(h).filter((body) => body.includes("lands work only from its executors"));
  assert.equal(excluded.length, 1);
  assertCommentRules(excluded[0]!, "Ada", h.ticket().id);

  h.forge.say(5, 2002, FINDINGS);
  await h.pass();
  assert.equal(issueComments(h).filter((body) => body.includes("lands work only from its executors")).length, 1, "the comment is posted once");
  assert.equal(h.ticket().state, "investigating");

  const listed = h.forge.say(5, 3003, FINDINGS);
  h.scripted.script("verdict", "1", { output: settledAfterFindings() });
  h.scripted.script("criteria", "1", { output: CRITERIA });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass(3);
  assert.equal((h.calls().find((c) => c.kind === "findings")!.detail as FindingsDetail).comment.id, listed.id);
  assert.equal(h.ticket().state, "cleared");
});
