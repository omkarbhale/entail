import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { afterAnswerPlanner } from "../src/after-answer.ts";
import { boardPlanner, type BoardItemSnapshot } from "../src/board-item.ts";
import type { ChallengeOutput } from "../src/challenge.ts";
import { assertCommentRules } from "../src/comment-rules.ts";
import { criteriaInForce, criteriaPlanner, type CriteriaDetail } from "../src/criteria.ts";
import { deciderPlanner } from "../src/decider.ts";
import type { ChangeBatch, Check, CheckReport, CommitChecks, Issue, MergeOutcome, PullRequest, PullRequestComment } from "../src/forge/forge.ts";
import { CLEARED_LABEL } from "../src/intake-comment.ts";
import { issueEdits, recordIssueEdit, type IssueEditDetail } from "../src/issue-edit.ts";
import { landingPlanner, type LandingMirror } from "../src/landing.ts";
import { landingGrader, type GradeMirror, type LandingChallengeOutput } from "../src/landing-grade.ts";
import { landingMerger } from "../src/merge.ts";
import { Mirror } from "../src/mirror.ts";
import type { CriteriaOutput, GradeOutput, RecheckOutput, VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import { pullRequestFollowing } from "../src/pull-requests.ts";
import {
  changedForExecutor,
  criteriaSourcesHold,
  RECHECK_PROMPT_VERSION,
  recheckOutcome,
  visionChanges,
  type RecheckDetail,
  type VisionChanges,
} from "../src/recheck.ts";
import type { GenericCriterion, Pin, RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { CallRecord, RepoRecord, TicketRecord } from "../src/store.ts";
import { blobAt } from "../src/vision-change.ts";
import { splitVisionLines } from "../src/vision.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { actor, IntakeForge, issue, passSetup, type PassSetup } from "./pass-fixture.ts";

const VISION = `# tally

tally counts the words of text files.

## Rules

tally never reaches the network.
A word is a run of characters between whitespace.
Output is plain text, one count per line.
`;
const WORD_LINE = "A word is a run of characters between whitespace.";
const WORD_LINE_REWORDED = "A word is a run of characters between any whitespace.";
const NEW_LINE = "Counts are exact.";
const JSON_LINE = "Machine-readable output is one JSON array per run.";
const ORIGIN = "http://127.0.0.1:7419";
const EXECUTOR = actor(2001, "executor");
const G1: GenericCriterion = { id: "G1", sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, source: ".github/workflows/ci.yml" };

const R1 = { id: "R1", reading: "Split words on whitespace only.", observed_outcome: "`tally` counts `a-b` as one word." };
const R2 = { id: "R2", reading: "Split words on punctuation too.", observed_outcome: "`tally` counts `a-b` as two words." };
const J1 = { id: "R1", reading: "Print one JSON object per input, one per line.", observed_outcome: "`tally --json a b` prints two lines of JSON." };
const J2 = { id: "R2", reading: "Print one JSON array of every input.", observed_outcome: "`tally --json a b` prints one JSON array." };

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
    close_evidence: [],
    questions: [],
    reason: "The vision defines a word, which chooses R1.",
    ...fields,
  };
}

function unopposed(): VerdictOutput {
  return settled({
    readings: [J1, J2],
    vision_check: [{ line: "tally counts the words of text files.", mark: "does_not_settle" }],
    verdict: "unopposed",
    citations: [],
    why_unopposed: "No vision line speaks to machine-readable output.",
    reading_chosen: "R1",
    reason: "Nothing in the vision opposes a JSON flag.",
  });
}

/** A re-check output: the prior settled call, standing, unless fields say otherwise. */
function recheckOf(fields: Partial<RecheckOutput> = {}): RecheckOutput {
  const { size: _s, close_evidence: _c, questions: _q, verdict: _v, ...call } = settled();
  return { outcome: "stands", ...call, verdict: "settled", reason: "The new line does not touch how words are split.", ...fields };
}

const SETTLED_CRITERIA: CriteriaOutput = {
  outcome: "criteria",
  criteria: [
    { id: "C1", sentence: "`tally` counts `a-b` as one word.", source: { kind: "issue", ref: null }, checks: [], states_reading: "R1" },
    { id: "C2", sentence: "Words stay runs of characters between whitespace.", source: { kind: "vision_line", ref: WORD_LINE }, checks: [{ kind: "check_passes", argument: "test" }], states_reading: null },
  ],
  product_call: null,
};

/** Criteria for the reworded word line. */
const REWORDED_CRITERIA: CriteriaOutput = {
  outcome: "criteria",
  criteria: [
    { id: "C1", sentence: "`tally` counts `a-b` as one word.", source: { kind: "issue", ref: null }, checks: [], states_reading: "R1" },
    { id: "C2", sentence: "Words stay runs of characters between any whitespace.", source: { kind: "vision_line", ref: WORD_LINE_REWORDED }, checks: [], states_reading: null },
  ],
  product_call: null,
};

const UNOPPOSED_CRITERIA: CriteriaOutput = {
  outcome: "criteria",
  criteria: [
    {
      id: "C1",
      sentence: "`tally --json` prints one JSON object per input, one per line.",
      source: { kind: "issue", ref: null },
      checks: [{ kind: "leaves_path", argument: "VISION.md" }],
      states_reading: "R1",
    },
  ],
  product_call: null,
};

const JSON_CRITERIA: CriteriaOutput = {
  outcome: "criteria",
  criteria: [
    { id: "C1", sentence: "`tally --json` prints one JSON array of every input.", source: { kind: "issue", ref: null }, checks: [], states_reading: "R2" },
    { id: "C2", sentence: "Machine-readable output is one JSON array per run.", source: { kind: "vision_line", ref: JSON_LINE }, checks: [], states_reading: null },
  ],
  product_call: null,
};

const UPHELD: ChallengeOutput = { outcome: "upheld", objections: [], reason: "Nothing overturns it." };
const OVERTURNED: ChallengeOutput = {
  outcome: "overturned",
  objections: [{ kind: "contradicted_line", objection: "Counting exactly contradicts splitting on whitespace only.", lines: [NEW_LINE], pin: null, reading: null, criterion: null }],
  reason: "The new line contradicts the reading.",
};

const GOOD_GRADE: GradeOutput = {
  results: [
    { id: "C1", result: "met", evidence: ["C1: ran `tally a-b` — it printed 1"], reason: "C1 holds." },
    { id: "C2", result: "met", evidence: ["C2: ran `npm test` — passed"], reason: "C2 holds." },
    { id: "G1", result: "met", evidence: ["test: passed"], reason: "G1 holds." },
  ],
  beyond_criteria: [],
  reason: "Every criterion is met.",
};
const BAD_GRADE: GradeOutput = {
  results: [
    { id: "C1", result: "not_met", evidence: [], reason: "Nothing shows `a-b` counted as one word." },
    { id: "C2", result: "met", evidence: ["C2: ran `npm test` — passed"], reason: "C2 holds." },
    { id: "G1", result: "met", evidence: ["test: passed"], reason: "G1 holds." },
  ],
  beyond_criteria: [],
  reason: "C1 is not met.",
};
const LANDING_UPHELD: LandingChallengeOutput = { outcome: "upheld", objections: [], reason: "Nothing to object to." };
const EVIDENCE = ["Counts hyphenated words as one.", "", "## entail evidence", "", "C1: ran `tally a-b` — it printed 1", "C2: ran `npm test` — passed", "G1: ran `npm test` — 14 passed"].join("\n");

function check(name: string, status: Check["status"]): Check {
  return { name, status, reported: true, url: null };
}

function headOf(number: number): string {
  return String(number).padStart(4, "0").padEnd(40, "f");
}

/** A forge with the check `test` on the default branch, and PRs that link issues, report checks and merge. */
class RecheckForge extends IntakeForge {
  prs: PullRequest[] = [];
  readonly links = new Map<number, number[]>();
  readonly merges: { number: number; sha: string }[] = [];

  override async recentDefaultBranchChecks(): Promise<CommitChecks[]> {
    return [{ sha: "c0ffee", checks: [check("test", "passed")] }];
  }

  override async changesSince(): Promise<ChangeBatch> {
    const batch = await super.changesSince();
    return { changes: [...batch.changes, ...this.prs.map((pr) => ({ kind: "pull-request" as const, id: pr.id, updatedAt: pr.updatedAt, pullRequest: this.#now(pr) }))], cursor: batch.cursor };
  }

  #now(pr: PullRequest): PullRequest {
    return { ...pr, state: this.state.prs[pr.number]?.state ?? pr.state };
  }

  override async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    return this.prs.filter((pr) => this.links.get(pr.number)?.includes(issueNumber)).map((pr) => this.#now(pr));
  }

  override async linkedIssues(pullRequestNumber: number): Promise<number[]> {
    return this.links.get(pullRequestNumber) ?? [];
  }

  override async pullRequest(number: number): Promise<PullRequest> {
    const pr = this.prs.find((p) => p.number === number)!;
    return { ...this.#now(pr), mergeable: true, conflicts: false };
  }

  override async checks(_pullRequestNumber: number, sha: string): Promise<CheckReport> {
    return { sha, checks: [check("test", "passed")], required: [] };
  }

  override async pullRequestComments(): Promise<PullRequestComment[]> {
    return [];
  }

  override async issue(issueNumber: number): Promise<Issue | null> {
    const found = this.issues.find((i) => i.number === issueNumber);
    return found === undefined ? null : { ...found, state: this.state.closed[issueNumber] ? "closed" : "open" };
  }

  override async merge(prNumber: number, sha: string): Promise<MergeOutcome> {
    this.merges.push({ number: prNumber, sha });
    return super.merge(prNumber, sha);
  }

  open(number: number, issueNumber: number): void {
    this.links.set(number, [issueNumber]);
    const pr: PullRequest = {
      id: 7000 + number,
      number,
      title: "Count hyphenated words as one",
      body: EVIDENCE,
      state: "open",
      draft: false,
      mergeable: null,
      conflicts: null,
      headSha: headOf(number),
      baseBranch: "main",
      author: EXECUTOR,
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:01.000Z",
      url: `https://github.com/acme/tally/pull/${number}`,
    };
    this.prs.push(pr);
    this.state.prs[number] = { state: "open", headSha: pr.headSha, mergeCommitSha: null };
  }

  commentsOn(number = 1): string[] {
    return (this.state.comments[`issue:${number}`] ?? []).map((c) => c.body);
  }

  prComments(number: number): string[] {
    return (this.state.comments[`pr:${number}`] ?? []).map((c) => c.body);
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  fixture: FixtureRepo;
  mirror: Mirror;
  forge: RecheckForge;
  runner: ScriptedRunner;
  engine: Passes;
  vision: VisionChanges;
  pass(times?: number): Promise<void>;
  idle(): Promise<void>;
  ticket(issueNumber?: number): TicketRecord;
  calls(issueNumber?: number, kind?: CallRecord["kind"]): CallRecord[];
  /** Commits and pushes a new VISION.md. */
  editVision(content: string, message?: string): string;
  /** Saves the repo's pins on its settings, as the settings page does. */
  setPins(pins: Pin[]): void;
  /** Takes issue 1 in and clears it on the scripted verdict, criteria and challenge. */
  clear(verdict?: VerdictOutput, criteria?: CriteriaOutput): Promise<TicketRecord>;
  /** Edits issue 1 on the forge, which the next pass reads as a change. */
  editIssue(fields: Partial<Issue>): void;
  kinds(): string[];
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

async function harness(t: TestContext): Promise<Harness> {
  const setup = passSetup(t);
  const fixture = new FixtureRepo(t);
  const enrolledAt = fixture.write("VISION.md", VISION).write("src/format.js", "export const format = (n) => String(n);\n").commit("vision");
  fixture.push();
  const repo = setup.enroll({ visionSha: enrolledAt, visionLines: splitVisionLines(VISION).map((line) => line.identity) });
  const settings = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
  setup.store.saveSettings(repo.id, { ...settings, pins: [], genericCriteria: [G1] }, "Ada");
  const mirror = await Mirror.open({
    dataDirectory: setup.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: repo.projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  const forge = new RecheckForge();
  const runner = new ScriptedRunner();
  const notifier = new Notifier({ connectorName: () => "file", connectors: {}, dataDirectory: setup.dataDirectory, log: setup.log });
  const common = { store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory };
  const vision = visionChanges({ ...common, board: { notifier, boardOrigin: ORIGIN }, mirrorFor: async () => mirror });
  const landingMirror: LandingMirror & GradeMirror = {
    fetchPullRequestHead: async (_number, expected) => ({ commit: expected!, fetched: false }),
    pullRequestChangedPaths: async () => ["src/count.js"],
    pullRequestHeadPaths: async () => ["README.md", "src/cli.js", "src/count.js", "test/count.test.js"],
    pullRequestDiff: async () => "diff --git a/src/count.js b/src/count.js\n+const words = text.split(/\\s+/);\n",
    checkout: async (commit) => ({ directory: `/checkouts/${commit}`, commit, dropped: [] }),
  };
  const merger = landingMerger({
    ...common,
    hold: vision.hold,
    processChanges: vision.processChanges,
    mirrorFor: async () => ({ updateDefaultBranch: () => mirror.updateDefaultBranch(), visionBlob: (commit) => blobAt(mirror.git, commit) }),
  });
  const grader = landingGrader({ ...common, hold: vision.hold, mirrorFor: async () => landingMirror, afterGrade: merger.afterGrade });
  const following = pullRequestFollowing(common);
  const engine = new Passes({
    ...common,
    forgeFor: () => forge,
    defaultBranchFor: async () => mirror,
    planners: [
      vision.planner,
      afterAnswerPlanner(common),
      deciderPlanner({ ...common, mirrorFor: async () => mirror }),
      criteriaPlanner({ ...common, mirrorFor: async () => mirror }),
      boardPlanner({ ...common, notifier, boardOrigin: ORIGIN, mirrorFor: async () => mirror }),
      merger.planner,
      following.planner,
      landingPlanner({ ...common, hold: vision.hold, mirrorFor: async () => landingMirror, afterMechanical: merger.reusingHeld(vision.reusingHeld(grader)) }),
    ],
    changeHandlers: [following.onChange, issueEdits(common).onChange],
    hooks: [vision.hook],
    modelRuns: new ModelRuns({ runner, log: setup.log }),
  });
  t.after(() => engine.stop());
  const idle = () => until(() => engine.stepsRunning === 0, "every step started has finished");
  const ticket = (issueNumber = 1) => setup.store.latestTicketForIssue(repo.id, issueNumber)!;
  const h: Harness = {
    setup,
    repo,
    fixture,
    mirror,
    forge,
    runner,
    engine,
    vision,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await idle();
      }
    },
    idle,
    ticket,
    calls: (issueNumber = 1, kind) => setup.store.callsForTicket(ticket(issueNumber).id).filter((call) => kind === undefined || call.kind === kind),
    editVision(content, message = "Edit the vision") {
      fixture.write("VISION.md", content);
      const sha = fixture.commit(message);
      fixture.push();
      return sha;
    },
    setPins(pins) {
      const latest = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
      setup.store.saveSettings(repo.id, { ...latest, pins }, "Ada");
    },
    async clear(verdict = settled(), criteria = SETTLED_CRITERIA) {
      forge.issues = [issue(1, { title: "Count hyphenated words", body: "Is `a-b` one word or two?" })];
      runner.script("verdict", "1", { output: verdict });
      runner.script("criteria", "1", { output: criteria });
      runner.script("challenge", "1", { output: UPHELD });
      await h.pass(3);
      const cleared = ticket();
      assert.ok(cleared.state === "cleared" || cleared.state === "landing", `cleared, not ${cleared.state}`);
      return cleared;
    },
    editIssue(fields) {
      edits++;
      const at = new Date(Date.parse("2026-11-09T02:00:00.000Z") + edits * 60_000).toISOString();
      forge.issues = forge.issues.map((i) => (i.number === 1 ? { ...i, ...fields, updatedAt: at } : i));
    },
    kinds: () => runner.requests.map((request) => request.kind),
  };
  let edits = 0;
  return h;
}

/** Runs passes until a run of this kind has started, leaving it in flight. */
async function passUntil(h: Harness, kind: string): Promise<void> {
  for (let i = 0; i < 5 && !h.kinds().includes(kind); i++) {
    await h.engine.runPass();
    await until(() => h.engine.stepsRunning === 0 || h.kinds().includes(kind), `a ${kind} run starts`);
  }
  assert.ok(h.kinds().includes(kind), `a ${kind} run started`);
}

function recheckCall(h: Harness): CallRecord & { detail: RecheckDetail } {
  return h.calls(1, "recheck").at(-1) as CallRecord & { detail: RecheckDetail };
}

// Reading a re-check's output, as pure functions.

test("a re-check stands only when its run says so and the call goes ahead on the same verdict and reading; otherwise it goes ahead differently or needs the owner", () => {
  const prior = { ...settled(), pin_matches: [] };
  assert.equal(recheckOutcome(prior, recheckOf()), "stands");
  assert.equal(recheckOutcome(prior, recheckOf({ readings: [{ ...R1, id: "R3" }, R2], citations: [{ lines: [WORD_LINE], reading: "R3" }] })), "stands", "the reading is the same, whatever its id");
  assert.equal(recheckOutcome(prior, recheckOf({ citations: [{ lines: [WORD_LINE], reading: "R2" }] })), "goes_ahead_differently", "it says it stands, but goes ahead on another reading");
  assert.equal(recheckOutcome(prior, recheckOf({ outcome: "goes_ahead_differently" })), "goes_ahead_differently");
  assert.equal(recheckOutcome(prior, recheckOf({ verdict: "unopposed", citations: [], reading_chosen: "R1", why_unopposed: "Nothing opposes it." })), "goes_ahead_differently");
  assert.equal(recheckOutcome(prior, recheckOf({ verdict: "needs_the_owner", why_raised: "contradiction" })), "needs_the_owner");
  assert.equal(recheckOutcome(prior, recheckOf({ outcome: "needs_the_owner" })), "needs_the_owner");
});

test("criteria are kept only while every vision line they are traced to is still a line; only what an executor reads counts as changed", () => {
  const criteria = [
    { id: "C1", sentence: "s", source: { kind: "issue" as const, ref: null }, checks: [], states_reading: null },
    { id: "C2", sentence: "s", source: { kind: "vision_line" as const, ref: WORD_LINE }, checks: [], states_reading: null },
  ];
  assert.equal(criteriaSourcesHold(criteria, splitVisionLines(VISION)), true);
  assert.equal(criteriaSourcesHold(criteria, splitVisionLines(VISION.replace(WORD_LINE, WORD_LINE_REWORDED))), false);

  const same = { priorCheck: [{ line: WORD_LINE, mark: "matches" }], check: [{ line: ` ${WORD_LINE}`, mark: "matches" }], priorCitation: [WORD_LINE], citation: [WORD_LINE], criteriaRewritten: false };
  assert.deepEqual(changedForExecutor(same), []);
  assert.deepEqual(changedForExecutor({ ...same, check: [{ line: WORD_LINE, mark: "does_not_settle" }] }), ["vision check"]);
  assert.deepEqual(changedForExecutor({ ...same, citation: [WORD_LINE_REWORDED], criteriaRewritten: true }), ["citation", "criteria version"]);
});

// Each outcome, on the pass, with the scripted runner.

test("outcome 1, stands: a line added elsewhere flags the ticket, and the re-check is recorded with no comment, keeping the criteria, state and label", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const comments = h.forge.commentsOn().length;
  const sha = h.editVision(`${VISION}${NEW_LINE}\n`, `Add a line\n\nVision-Origin: agent-proposed-owner-approved\n`);
  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();

  const [change] = h.setup.store.visionChanges(h.repo.id);
  assert.deepEqual(change!.added, [NEW_LINE]);
  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "stands");
  assert.deepEqual([call.detail.recheck.criteriaVersion, call.detail.recheck.criteriaRewritten, call.detail.recheck.changed], [1, false, []]);
  assert.deepEqual(call.detail.visionChangeIds, [change!.id]);
  assert.deepEqual([call.citation?.visionSha, call.citation?.lines], [sha, [WORD_LINE]]);
  assert.equal(call.inputs?.visionSha, sha);
  assert.deepEqual(call.modelRuns.map((run) => [run.purpose, run.promptVersion]), [["re-check", RECHECK_PROMPT_VERSION], ["challenge", "challenge-4"]]);
  const prompt = h.runner.requests.find((request) => request.kind === "re-check")!.prompt;
  assert.match(prompt, /Added lines, each with its recorded origin:\n- "Counts are exact\." \(origin: agent-proposed-owner-approved\)/);
  assert.match(prompt, /"reading_chosen": null/);

  assert.equal(h.ticket().state, "cleared");
  assert.equal(criteriaInForce(h.calls())?.version, 1);
  assert.equal(h.forge.commentsOn().length, comments, "nothing an executor reads changed, so the issue gets no comment");
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL]);
  // The Calls page lists it under its vision change.
  assert.deepEqual(h.setup.store.listCalls({ visionChangeId: change!.id }).map((c) => c.id), [call.id]);

  // Recorded, the flag is resolved: no second re-check.
  await h.pass(2);
  assert.equal(h.calls(1, "recheck").length, 1);
});

test("outcome 1, stands with the cited line reworded: the call carries the new citation, the criteria are rewritten, and a new intake comment names the one it replaces and the vision change", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const first = h.forge.commentsOn();
  const sha = h.editVision(VISION.replace(WORD_LINE, WORD_LINE_REWORDED));
  h.runner.script("re-check", String(ticket.id), {
    output: recheckOf({ vision_check: [{ line: WORD_LINE_REWORDED, mark: "matches" }], citations: [{ lines: [WORD_LINE_REWORDED], reading: "R1" }] }),
  });
  h.runner.script("criteria", String(ticket.id), { output: REWORDED_CRITERIA });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();

  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "stands");
  assert.deepEqual(call.detail.recheck.removed, [WORD_LINE]);
  assert.deepEqual(call.detail.recheck.added, [WORD_LINE_REWORDED]);
  assert.deepEqual(call.citation?.lines, [WORD_LINE_REWORDED]);
  assert.deepEqual(call.detail.recheck.changed, ["vision check", "citation", "criteria version"]);
  const criteria = criteriaInForce(h.calls())!;
  assert.deepEqual([criteria.version, criteria.verdictCallId, criteria.criteria[1]?.source.ref], [2, call.id, WORD_LINE_REWORDED]);
  assert.deepEqual(criteria.genericCriteria, [G1], "the generic criteria stay frozen");
  assert.equal(h.ticket().state, "cleared");

  const comments = h.forge.commentsOn();
  assert.equal(comments.length, first.length + 1);
  const body = comments.at(-1)!;
  assertCommentRules(body, "Ada", ticket.id);
  assert.match(body, new RegExp(`This replaces \\[entail's earlier intake comment\\]\\([^)]+\\), after the vision change at \`${sha.slice(0, 7)}\`\\.`));
  assert.match(body, /Words stay runs of characters between any whitespace\./);
  assert.match(body, new RegExp(`/blob/${sha}/VISION\\.md#L8`));
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL], "the label stays");
});

test("outcome 2, goes ahead differently: an unopposed ticket now settled on another reading gets a new criteria version and keeps its state", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear(unopposed(), UNOPPOSED_CRITERIA);
  h.editVision(`${VISION}${JSON_LINE}\n`);
  h.runner.script("re-check", String(ticket.id), {
    output: recheckOf({
      outcome: "goes_ahead_differently",
      readings: [J1, J2],
      vision_check: [{ line: JSON_LINE, mark: "matches" }],
      citations: [{ lines: [JSON_LINE], reading: "R2" }],
      reason: "The new line settles the JSON shape: one array.",
    }),
  });
  h.runner.script("criteria", String(ticket.id), { output: JSON_CRITERIA });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();

  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "goes_ahead_differently");
  assert.equal(call.noContradictionFound, false);
  assert.deepEqual(call.citation?.lines, [JSON_LINE]);
  const criteria = criteriaInForce(h.calls())!;
  assert.deepEqual([criteria.version, criteria.verdict, criteria.fences], [2, "settled", []]);
  assert.equal(h.ticket().state, "cleared");
  assert.match(h.forge.commentsOn().at(-1)!, /one JSON array of every input/);
});

test("outcome 3, needs the owner: the ticket goes on the board, loses entail:cleared, and each open PR gets one comment; on \"don't go ahead\" it is cancelled and the PR gets one more, but is not closed", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  // One PR opened while the ticket was still deciding, which got the one-time comment that it has no criteria yet.
  const earlier = h.setup.store.recordForgeWriteIntent({ repoId: h.repo.id, ticketId: ticket.id, kind: "comment", target: "pr", number: 13, payload: { body: "No criteria yet.", purpose: "pr-no-criteria" } });
  const posted = await h.forge.postComment("pr", 13, "No criteria yet.");
  h.setup.store.confirmForgeWrite({ intentId: earlier.id, comment: { id: String(posted.id), url: posted.url } });
  h.forge.open(13, 1);
  h.forge.open(12, 1);
  await h.pass();
  assert.equal(h.ticket().state, "landing");
  for (const _pr of [12, 13]) {
    h.runner.script("grade", String(ticket.id), { output: GOOD_GRADE });
    h.runner.script("landing-challenge", String(ticket.id), { output: LANDING_UPHELD });
  }

  const sha = h.editVision(`${VISION}Hyphenated words count as two.\n`);
  h.runner.script("re-check", String(ticket.id), {
    output: recheckOf({ outcome: "needs_the_owner", verdict: "needs_the_owner", vision_check: [{ line: "Hyphenated words count as two.", mark: "contradicts" }], citations: [], why_raised: "contradiction" }),
  });
  await h.pass(2);

  assert.equal(h.ticket().state, "on-the-board");
  assert.deepEqual(h.forge.merges, [], "no PR for it merges");
  assert.deepEqual(h.forge.state.labels[1], []);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  assert.equal(item.whyRaised, "contradiction");
  assert.match(h.forge.commentsOn().at(-1)!, new RegExp(`after the vision change at \`${sha.slice(0, 7)}\``));
  const [raised, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(raised!, new RegExp(`entail raised #1 to the owner after the vision change at \`${sha.slice(0, 7)}\``));
  assertCommentRules(raised!, "Ada", ticket.id);
  assert.equal(h.forge.prComments(13).length, 2, "the PR told earlier that the ticket had no criteria yet is told it was raised too");
  assert.match(h.forge.prComments(13)[1]!, /entail raised #1 to the owner/);
  assert.equal(h.kinds().filter((kind) => kind === "challenge").length, 1, "a call that needs the owner is not challenged");

  // Following its PRs posts no second comment on the board ticket's PRs.
  await h.pass();
  assert.equal(h.forge.prComments(12).length, 1);
  assert.equal(h.forge.prComments(13).length, 2);

  h.setup.store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "dont-go-ahead" });
  await h.pass(2);
  assert.equal(h.ticket().state, "cancelled");
  assert.equal(h.forge.state.closed[1], "not-planned");
  assert.equal(h.forge.state.prs[12]?.state, "open", "the PR is not closed");
  const prComments = h.forge.prComments(12);
  assert.equal(prComments.length, 2);
  assert.match(prComments[1]!, /The owner decided not to go ahead with #1 after a vision change, so its ticket is cancelled\./);
  assert.equal(h.forge.prComments(13).length, 3);
  // A later change on the PR gets no "ended" comment on top.
  h.forge.prs[0] = { ...h.forge.prs[0]!, updatedAt: "2026-11-09T01:00:00.000Z" };
  await h.pass();
  assert.equal(h.forge.prComments(13).length, 3);
});

test("outcome 3 from a failed mechanical check: a re-check that says it stands but quotes a line not in VISION.md needs the owner, with no challenge run", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.editVision(`${VISION}${NEW_LINE}\n`);
  h.runner.script("re-check", String(ticket.id), { output: recheckOf({ vision_check: [{ line: WORD_LINE, mark: "matches" }, { line: "Counts are exactish.", mark: "does_not_settle" }] }) });
  await h.pass(2);
  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "needs_the_owner");
  assert.equal(call.detail.recheck.judged, "stands");
  assert.equal((call.checks as { passed: boolean }).passed, false);
  assert.equal(h.ticket().state, "on-the-board");
  assert.equal(h.setup.store.openBoardItem(ticket.id)?.whyRaised, "failed_check");
  assert.equal(h.kinds().filter((kind) => kind === "challenge").length, 1, "only the first clear was challenged");
});

test("outcome 3 from the challenge: a re-check the challenge overturns needs the owner", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.editVision(`${VISION}${NEW_LINE}\n`);
  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: OVERTURNED });
  await h.pass(2);
  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "needs_the_owner");
  assert.equal((call.challenge as { overturned: boolean }).overturned, true);
  assert.equal(h.ticket().state, "on-the-board");
  const item = h.setup.store.openBoardItem(ticket.id)!;
  assert.equal(item.whyRaised, "challenge");
  assert.match((item.snapshot as BoardItemSnapshot).why.text, /Counting exactly contradicts/);

  // Going ahead writes a new criteria version from the answer, and the ticket is cleared again.
  h.setup.store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "option", optionId: "R1" });
  h.runner.script("criteria", String(ticket.id), {
    output: { ...SETTLED_CRITERIA, criteria: [{ id: "C1", sentence: "`tally` counts `a-b` as one word.", source: { kind: "answer", ref: null }, checks: [], states_reading: null }] },
  });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass(3);
  assert.equal(h.ticket().state, "cleared");
  const criteria = criteriaInForce(h.calls()) as CriteriaDetail;
  assert.deepEqual([criteria.version, criteria.verdictCallId], [2, call.id]);

  // Cleared on the owner's answer, it is not flagged by the next vision change.
  h.editVision(`${VISION}${NEW_LINE}\nAnother line.\n`);
  await h.pass(2);
  assert.equal(h.calls(1, "recheck").length, 1);
  assert.equal(h.vision.flags.flag(ticket.id), null);
});

test("a change that adds nothing and removes no cited line flags nothing", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.editVision(VISION.replace("Output is plain text, one count per line.\n", ""));
  await h.pass(2);
  assert.equal(h.setup.store.visionChanges(h.repo.id).length, 1);
  assert.equal(h.vision.flags.flag(ticket.id), null);
  assert.equal(h.calls(1, "recheck").length, 0);
});

// Holding the merge and the landing check.

test("a flagged ticket merges nothing until its re-check is recorded, with no comment for the hold; the landing check in progress is reused", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.forge.open(12, 1);
  await h.pass();
  assert.equal(h.ticket().state, "landing");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("grade", String(ticket.id), { output: GOOD_GRADE, until: gate });
  h.runner.script("landing-challenge", String(ticket.id), { output: LANDING_UPHELD });
  await passUntil(h, "grade");

  // A vision change lands while the landing check is in progress.
  h.editVision(`${VISION}${NEW_LINE}\n`);
  await h.engine.runPass();
  assert.equal(h.setup.store.visionChanges(h.repo.id).length, 1);
  release();
  await h.idle();

  assert.deepEqual(h.forge.merges, [], "the passing landing check merges nothing while the ticket is flagged");
  assert.deepEqual(h.forge.prComments(12), [], "and posts nothing for the hold");
  assert.deepEqual(h.calls(1, "landing"), []);

  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass(3);
  assert.equal(recheckCall(h).detail.recheck.outcome, "stands");
  assert.equal(h.ticket().state, "merged");
  assert.equal(h.forge.merges.length, 1);
  assert.equal(h.kinds().filter((kind) => kind === "grade").length, 1, "the criteria version is unchanged, so the grade is reused");
  assert.match(h.forge.prComments(12).at(-1)!, /Merging at/);
});

test("a failing landing check in progress when a flag lands posts nothing until the re-check is recorded, then posts its result without grading again", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.forge.open(12, 1);
  await h.pass();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("grade", String(ticket.id), { output: BAD_GRADE, until: gate });
  await passUntil(h, "grade");
  h.editVision(`${VISION}${NEW_LINE}\n`);
  await h.engine.runPass();
  release();
  await h.idle();
  assert.deepEqual(h.forge.prComments(12), []);

  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass(2);
  const comments = h.forge.prComments(12);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!, /C1/);
  assert.equal(h.calls(1, "landing").length, 1);
  assert.equal(h.kinds().filter((kind) => kind === "grade").length, 1);
  assert.equal(h.ticket().state, "landing");
});

test("a vision change found by the merge guard's last look is recorded first, and holds the merge of a ticket it flags", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const pass = { repo: h.repo } as Parameters<typeof h.vision.processChanges>[0]["pass"];
  assert.deepEqual(await h.vision.processChanges({ tickets: [ticket], pass, changes: { vision: null, issues: [] } }), { flagged: false });

  const sha = h.editVision(`${VISION}${NEW_LINE}\n`);
  // The merge guard fetches the default branch before it asks.
  await h.mirror.updateDefaultBranch();
  const changes = { vision: { fromCommit: "unused", toCommit: sha, fromBlob: null, toBlob: null }, issues: [] };
  assert.deepEqual(await h.vision.processChanges({ tickets: [ticket], pass, changes }), { flagged: true });
  assert.deepEqual(h.setup.store.visionChanges(h.repo.id).map((c) => [c.commitSha, c.added]), [[sha, [NEW_LINE]]]);
});

// Another change before the re-check is recorded, other states.

test("another vision change before the re-check is recorded restarts it with every change so far", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.editVision(`${VISION}${NEW_LINE}\n`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("re-check", String(ticket.id), { output: recheckOf(), until: gate });
  await passUntil(h, "re-check");

  h.editVision(`${VISION}${NEW_LINE}\nOutput is exact.\n`);
  await h.engine.runPass();
  release();
  await h.idle();
  assert.equal(h.calls(1, "recheck").length, 0, "the re-check in flight is discarded");

  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  const call = recheckCall(h);
  const changes = h.setup.store.visionChanges(h.repo.id);
  assert.deepEqual(call.detail.visionChangeIds, changes.map((c) => c.id));
  assert.deepEqual(call.detail.recheck.added, [NEW_LINE, "Output is exact."]);
  const prompts = h.runner.requests.filter((request) => request.kind === "re-check").map((request) => request.prompt);
  assert.match(prompts[1]!, /Counts are exact\.[^\n]*\n- "Output is exact\."/);
});

test("an open board item a vision change touches is withdrawn, and its ticket decided again at the current vision", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1, { title: "Fetch a URL", body: "Count the words of a web page." })];
  h.runner.script("verdict", "1", {
    output: settled({ verdict: "needs_the_owner", citations: [], vision_check: [{ line: "tally never reaches the network.", mark: "contradicts" }], why_raised: "contradiction", reason: "It reaches the network." }),
  });
  await h.pass(2);
  const ticket = h.ticket();
  assert.equal(ticket.state, "on-the-board");
  const item = h.setup.store.openBoardItem(ticket.id)!;

  const sha = h.editVision(VISION.replace("tally never reaches the network.", "tally reaches the network only for URLs it is given."));
  h.runner.script("verdict", "1", { output: settled({ verdict: "needs_the_owner", citations: [], why_raised: "consequential_readings", vision_check: [], reason: "Still open." }) });
  await h.pass(3);

  const history = h.setup.store.boardItem(item.id)!;
  assert.match(history.withdrawal?.reason ?? "", /VISION\.md changed/);
  const withdrawal = h.calls(1, "recheck")[0]!;
  assert.deepEqual(withdrawal.stateChange, { from: "on-the-board", to: "deciding" });
  assert.equal(withdrawal.inputs?.visionSha, sha);
  const verdicts = h.calls(1, "verdict");
  assert.equal(verdicts.length, 2, "decided again");
  assert.equal(verdicts[1]!.inputs?.visionSha, sha);
  assert.equal(h.ticket().state, "on-the-board", "and raised again on the new verdict");
});

test("a deciding ticket's verdict run in flight when a vision change is recorded is discarded, and the ticket decided at the new vision", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1, { title: "Count hyphenated words", body: "Is `a-b` one word or two?" })];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("verdict", "1", { output: settled(), until: gate });
  await passUntil(h, "verdict");
  const sha = h.editVision(`${VISION}${NEW_LINE}\n`);
  await h.engine.runPass();
  release();
  await h.idle();
  assert.deepEqual(h.calls(1, "verdict"), []);

  h.runner.script("verdict", "1", { output: settled() });
  await h.pass();
  assert.equal(h.calls(1, "verdict")[0]?.inputs?.visionSha, sha);
});

test("while VISION.md is gone the repo is halted: a flagged ticket is neither re-checked nor merged, until a vision is back", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  // A line is added, and the change recorded and flagged on the merge guard's last look, before any pass.
  h.editVision(`${VISION}${NEW_LINE}\n`);
  await h.mirror.updateDefaultBranch();
  const pass = { repo: h.repo } as Parameters<typeof h.vision.processChanges>[0]["pass"];
  await h.vision.processChanges({ tickets: [ticket], pass, changes: { vision: { fromCommit: "unused", toCommit: h.fixture.head(), fromBlob: null, toBlob: null }, issues: [] } });
  await h.vision.flags.refresh(h.repo);
  assert.notEqual(h.vision.flags.flag(ticket.id), null);

  // Then VISION.md goes.
  h.fixture.remove("VISION.md").commit("Remove the vision");
  h.fixture.push();
  await h.pass(2);
  assert.equal(h.engine.visionGoneSince(h.repo.id) !== null, true);
  assert.equal(h.kinds().includes("re-check"), false, "nothing is re-checked while the vision is gone");
  assert.equal(await h.vision.hold.held(ticket, pass), true, "and nothing lands");

  h.editVision(`${VISION}${NEW_LINE}\nOutput is exact.\n`, "Restore the vision with another line");
  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  assert.equal(recheckCall(h).detail.recheck.outcome, "stands");
  assert.deepEqual(recheckCall(h).detail.recheck.added, [NEW_LINE, "Output is exact."]);
  assert.equal(h.setup.store.visionChanges(h.repo.id).length, 2, "the vision back is recorded against the last vision of record");
});

// Pin changes (spec §12, §15, ADR-0018): the same re-check, flags and withdrawals.

const FORMAT_PIN: Pin = { topic: "the output format", paths: ["src/format.js"], keywords: ["format"] };
const NETWORK_PIN: Pin = { topic: "network access", paths: [], keywords: ["http"] };

function heldPass(h: Harness): Parameters<VisionChanges["processChanges"]>[0]["pass"] {
  return { repo: h.repo } as Parameters<VisionChanges["processChanges"]>[0]["pass"];
}

test("adding a pin flags a cleared ticket at once, so nothing merges until its re-check, which runs at the current pins and is recorded with the pin added", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const comments = h.forge.commentsOn().length;
  assert.equal(await h.vision.hold.held(ticket, heldPass(h)), false);

  h.setPins([FORMAT_PIN]);
  assert.equal(await h.vision.hold.held(ticket, heldPass(h)), true, "the merge is held from the save, before any pass");
  h.runner.script("re-check", String(ticket.id), { output: recheckOf({ reason: "The ticket does not touch the output format." }) });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();

  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "stands");
  assert.deepEqual(call.detail.recheck.pinsAdded, [FORMAT_PIN]);
  assert.deepEqual([call.detail.recheck.pinsRemoved, call.detail.recheck.removed, call.detail.recheck.added, call.detail.visionChangeIds], [[], [], [], []]);
  assert.match(call.reason, /^Re-checked after the pin change adding the pin “the output format”: the call stands\./);
  assert.deepEqual(
    (call.inputs?.pins as Pin[]).map((pin) => pin.topic),
    ["The product's vision, VISION.md", "the output format"],
    "the re-check judged the current pins",
  );
  const prompt = h.runner.requests.find((request) => request.kind === "re-check")!.prompt;
  assert.match(prompt, /Added pins:\n- \{"topic":"the output format","paths":\["src\/format\.js"\],"keywords":\["format"\]\}/);
  assert.match(prompt, /Removed pins:\nNone\./);
  assert.match(h.runner.requests.filter((request) => request.kind === "challenge").at(-1)!.prompt, /"topic": "the output format"/, "and is challenged at them");

  assert.equal(h.ticket().state, "cleared");
  assert.equal(criteriaInForce(h.calls())?.version, 1);
  assert.equal(h.forge.commentsOn().length, comments, "nothing an executor reads changed, so the issue gets no comment");
  assert.equal(await h.vision.hold.held(ticket, heldPass(h)), false, "recorded, the merge is no longer held");
  await h.pass(2);
  assert.equal(h.calls(1, "recheck").length, 1, "no second re-check");
});

test("a re-check after a pin was added that finds the pin touched raises the ticket; the issue and PR are told the repo's pins changed, never which pin", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.forge.open(12, 1);
  await h.pass();
  assert.equal(h.ticket().state, "landing");
  h.runner.script("grade", String(ticket.id), { output: GOOD_GRADE });
  h.runner.script("landing-challenge", String(ticket.id), { output: LANDING_UPHELD });

  h.setPins([FORMAT_PIN]);
  h.runner.script("re-check", String(ticket.id), {
    output: recheckOf({
      outcome: "needs_the_owner",
      verdict: "needs_the_owner",
      citations: [],
      pins_touched: [{ pin: FORMAT_PIN.topic, why: "Counting hyphenated words changes the printed counts." }],
      why_raised: "pin",
      open_readings: ["R1", "R2"],
    }),
  });
  await h.pass(2);

  assert.equal(h.ticket().state, "on-the-board");
  assert.deepEqual(h.forge.merges, [], "no PR for it merges");
  assert.deepEqual(h.forge.state.labels[1], []);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  assert.equal(item.whyRaised, "pin");
  assert.match((item.snapshot as BoardItemSnapshot).why.text, /It touches the pin “the output format”/);
  assert.match(recheckCall(h).reason, /^Re-checked after the pin change adding the pin “the output format”: it needs the owner/);

  const intake = h.forge.commentsOn().at(-1)!;
  assert.match(intake, /after a change to the repo's pins\./);
  assert.doesNotMatch(intake, /output format|vision change/, "the pin is not named on the forge");
  const [raised, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(raised!, /entail raised #1 to the owner after a change to the repo's pins\./);
  assert.doesNotMatch(raised!, /output format/);
  assertCommentRules(raised!, "Ada", ticket.id);

  h.setup.store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "dont-go-ahead" });
  await h.pass(2);
  assert.equal(h.ticket().state, "cancelled");
  assert.equal(h.forge.state.prs[12]?.state, "open", "the PR is not closed");
  assert.match(h.forge.prComments(12)[1]!, /The owner decided not to go ahead with #1 after a change to the repo's pins, so its ticket is cancelled\./);
});

test("editing a pin behaves as removing the old one and adding the new: it flags the ticket, and the re-check is given both", async (t) => {
  const h = await harness(t);
  h.setPins([FORMAT_PIN, NETWORK_PIN]);
  const ticket = await h.clear();
  assert.equal(await h.vision.hold.held(ticket, heldPass(h)), false);

  const edited: Pin = { ...FORMAT_PIN, keywords: ["format", "printf"] };
  h.setPins([edited, NETWORK_PIN]);
  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();

  const call = recheckCall(h);
  assert.deepEqual([call.detail.recheck.pinsRemoved, call.detail.recheck.pinsAdded], [[FORMAT_PIN], [edited]]);
  assert.match(call.reason, /after the pin change adding the pin “the output format” and removing the pin “the output format”/);
  const prompt = h.runner.requests.find((request) => request.kind === "re-check")!.prompt;
  assert.match(prompt, /Removed pins:\n- \{"topic":"the output format","paths":\["src\/format\.js"\],"keywords":\["format"\]\}/);
  assert.match(prompt, /Added pins:\n- \{"topic":"the output format","paths":\["src\/format\.js"\],"keywords":\["format","printf"\]\}/);
});

test("removing a pin flags nothing; a pin added later flags the ticket, and its re-check is given every pin change so far", async (t) => {
  const h = await harness(t);
  h.setPins([FORMAT_PIN, NETWORK_PIN]);
  const ticket = await h.clear();

  h.setPins([NETWORK_PIN]);
  assert.equal(await h.vision.hold.held(ticket, heldPass(h)), false, "removing a pin holds no merge");
  await h.pass(2);
  assert.equal(h.kinds().includes("re-check"), false);
  assert.deepEqual(h.calls(1, "recheck"), []);
  assert.equal(h.vision.flags.flag(ticket.id), null);

  const added: Pin = { topic: "exit codes", paths: [], keywords: ["exit"] };
  h.setPins([NETWORK_PIN, added]);
  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  const call = recheckCall(h);
  assert.deepEqual([call.detail.recheck.pinsRemoved, call.detail.recheck.pinsAdded], [[FORMAT_PIN], [added]]);
});

test("a ticket cleared by the owner's answer is not flagged by an added pin, as by a vision change", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.editVision(`${VISION}${NEW_LINE}\n`);
  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: OVERTURNED });
  await h.pass(2);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  h.setup.store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "option", optionId: "R1" });
  h.runner.script("criteria", String(ticket.id), {
    output: { ...SETTLED_CRITERIA, criteria: [{ id: "C1", sentence: "`tally` counts `a-b` as one word.", source: { kind: "answer", ref: null }, checks: [], states_reading: null }] },
  });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass(3);
  assert.equal(h.ticket().state, "cleared");

  h.setPins([FORMAT_PIN]);
  assert.equal(await h.vision.hold.held(h.ticket(), heldPass(h)), false);
  await h.pass(2);
  assert.equal(h.calls(1, "recheck").length, 1, "only the vision change's re-check");
});

test("another pin change before the re-check is recorded restarts it with every change so far", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.setPins([FORMAT_PIN]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("re-check", String(ticket.id), { output: recheckOf(), until: gate });
  await passUntil(h, "re-check");

  h.setPins([FORMAT_PIN, NETWORK_PIN]);
  await h.engine.runPass();
  release();
  await h.idle();
  assert.equal(h.calls(1, "recheck").length, 0, "the re-check in flight is discarded");

  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  assert.deepEqual(recheckCall(h).detail.recheck.pinsAdded, [FORMAT_PIN, NETWORK_PIN]);
});

test("a pin change withdraws the open board items it touches, and their tickets are decided again; removing a pin an item does not name leaves it", async (t) => {
  const h = await harness(t);
  h.setPins([FORMAT_PIN, NETWORK_PIN]);
  h.forge.issues = [issue(1, { title: "Print counts as a table", body: "Change how counts are printed." })];
  const raisedForPin = (reason: string) =>
    settled({
      verdict: "needs_the_owner",
      citations: [],
      pins_touched: [{ pin: FORMAT_PIN.topic, why: "It changes the printed output." }],
      why_raised: "pin",
      open_readings: ["R1", "R2"],
      reason,
    });
  h.runner.script("verdict", "1", { output: raisedForPin("It touches the output format pin.") });
  await h.pass(2);
  const ticket = h.ticket();
  assert.equal(ticket.state, "on-the-board");
  const first = h.setup.store.openBoardItem(ticket.id)!;

  // Removing a pin the item does not name leaves it open.
  h.setPins([FORMAT_PIN]);
  await h.pass(2);
  assert.equal(h.setup.store.openBoardItem(ticket.id)?.id, first.id);
  assert.deepEqual(h.calls(1, "recheck"), []);

  // Removing the pin it names withdraws it, and the ticket is decided again at the current pins.
  h.runner.script("verdict", "1", { output: settled({ verdict: "needs_the_owner", citations: [], why_raised: "consequential_readings", open_readings: ["R1", "R2"], reason: "Still open." }) });
  h.setPins([]);
  await h.pass(3);
  assert.match(h.setup.store.boardItem(first.id)!.withdrawal?.reason ?? "", /^The pin “the output format” changed\.$/);
  const withdrawal = h.calls(1, "recheck")[0]!;
  assert.deepEqual(withdrawal.stateChange, { from: "on-the-board", to: "deciding" });
  // The call records every pin change since the item was raised; the item names only the pin that touched it.
  assert.match(withdrawal.reason, /^The pin change removing the pins “the output format” and “network access”, so the open board item is withdrawn and the ticket decided again/);
  assert.deepEqual((withdrawal.detail as { withdrawn: { pinsRemoved: Pin[] } }).withdrawn.pinsRemoved, [FORMAT_PIN, NETWORK_PIN]);
  const verdicts = h.calls(1, "verdict");
  assert.equal(verdicts.length, 2, "decided again");
  assert.deepEqual((verdicts[1]!.inputs?.pins as Pin[]).map((pin) => pin.topic), ["The product's vision, VISION.md"]);
  assert.equal(h.ticket().state, "on-the-board", "and raised again on the new verdict");
  const second = h.setup.store.openBoardItem(ticket.id)!;
  assert.notEqual(second.id, first.id);

  // Adding a pin touches every open item, as an added vision line does.
  h.runner.script("verdict", "1", { output: raisedForPin("It touches the output format pin again.") });
  h.setPins([FORMAT_PIN]);
  await h.pass(3);
  assert.match(h.setup.store.boardItem(second.id)!.withdrawal?.reason ?? "", /^The pin “the output format” changed\.$/);
  assert.equal(h.calls(1, "verdict").length, 3);
  assert.equal(h.setup.store.openBoardItem(ticket.id)?.whyRaised, "pin");
  assert.equal(h.setup.logLines().some((line) => line.event === "board-item-withdrawn" && line.why === "pin-change"), true);
});

// Issue edits (ADR-0020): the same re-check as a vision change, given the old and new text.

const TITLE = "Count hyphenated words";
const BODY = "Is `a-b` one word or two?";
const EDITED = "Is `a-b` one word or two? Treat `a_b` the same way.";

function editCall(h: Harness, at = -1): CallRecord & { detail: IssueEditDetail } {
  return h.calls(1, "issue-edit").at(at) as CallRecord & { detail: IssueEditDetail };
}

/** A needs-the-owner verdict on consequential readings, answered "go ahead" with R1, and cleared on the answer. */
async function clearOnAnswer(h: Harness): Promise<{ ticket: TicketRecord; answerId: number }> {
  h.forge.issues = [issue(1, { title: TITLE, body: BODY })];
  h.runner.script("verdict", "1", { output: ANSWERED_PRIOR });
  await h.pass(2);
  const item = h.setup.store.openBoardItem(h.ticket().id)!;
  const answer = h.setup.store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "option", optionId: "R1" });
  h.runner.script("criteria", String(h.ticket().id), { output: ANSWER_CRITERIA });
  h.runner.script("challenge", String(h.ticket().id), { output: UPHELD });
  await h.pass(3);
  assert.equal(h.ticket().state, "cleared");
  return { ticket: h.ticket(), answerId: answer.id };
}

const ANSWERED_PRIOR = settled({
  verdict: "needs_the_owner",
  citations: [],
  vision_check: [{ line: WORD_LINE, mark: "does_not_settle" }],
  why_raised: "consequential_readings",
  open_readings: ["R1", "R2"],
  reason: "Whether a hyphen splits words is consequential.",
});

const ANSWER_CRITERIA: CriteriaOutput = {
  outcome: "criteria",
  criteria: [{ id: "C1", sentence: "`tally` counts `a-b` as one word.", source: { kind: "answer", ref: null }, checks: [], states_reading: null }],
  product_call: null,
};

/** A re-check of a ticket cleared on the owner's answer: the prior call's fields as they were. */
function answeredRecheck(fields: Partial<RecheckOutput> = {}): RecheckOutput {
  const { size: _s, close_evidence: _c, questions: _q, verdict: _v, ...call } = ANSWERED_PRIOR;
  return { outcome: "stands", ...call, verdict: "needs_the_owner", reason: "The edit does not change what the answer decided.", ...fields };
}

test("an edit to a cleared ticket's issue flags it: its re-check is given the old and new text, and standing keeps the criteria, state and label with no comment; whitespace and labels are no edit", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const comments = h.forge.commentsOn().length;

  // Whitespace, a label and the update time alone change nothing.
  h.editIssue({ body: `${BODY.replace("one word", "one  word")}\n\n`, labels: ["bug"] });
  await h.pass();
  assert.deepEqual(h.calls(1, "issue-edit"), []);
  assert.equal(h.vision.flags.flag(ticket.id), null);

  h.editIssue({ body: EDITED });
  h.runner.script("re-check", String(ticket.id), { output: recheckOf({ reason: "Treating `a_b` the same way does not change how words are split." }) });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();

  const edit = editCall(h);
  assert.equal(edit.stateChange, null, "a cleared ticket keeps its state");
  assert.deepEqual(edit.detail.edit, { from: { title: TITLE, body: BODY }, to: { title: TITLE, body: EDITED } });
  assert.deepEqual([edit.inputs?.issueTitle, edit.inputs?.issueBody], [TITLE, EDITED]);
  const call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "stands");
  assert.deepEqual(call.detail.recheck.issueEdit, { from: { title: TITLE, body: BODY }, to: { title: TITLE, body: EDITED }, editCallIds: [edit.id] });
  assert.deepEqual(call.detail.visionChangeIds, []);
  assert.equal(call.detail.recheck.answered, false);
  assert.deepEqual([call.detail.recheck.criteriaVersion, call.detail.recheck.criteriaRewritten, call.detail.recheck.changed], [1, false, []]);
  assert.equal(call.inputs?.issueBody, EDITED, "the re-check judged the latest text");
  assert.match(call.reason, /^Re-checked after an edit to the issue: the call stands\./);
  const prompt = h.runner.requests.find((request) => request.kind === "re-check")!.prompt;
  assert.match(prompt, /re-checking one ticket after a change to the issue's title or body\./);
  assert.match(prompt, /## The issue's edit since the prior call/);
  assert.ok(prompt.includes(JSON.stringify({ before: { title: TITLE, body: BODY }, now: { title: TITLE, body: EDITED } }, null, 2)));
  assert.match(prompt, /Removed lines \(a reworded line is one removed and one added\):\nNone\./);

  assert.equal(h.ticket().state, "cleared");
  assert.equal(criteriaInForce(h.calls())?.version, 1);
  assert.equal(h.forge.commentsOn().length, comments, "nothing an executor reads changed, so the issue gets no comment");
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL]);
  await h.pass(2);
  assert.equal(h.calls(1, "recheck").length, 1, "recorded, the flag is resolved");
});

test("an edit that makes a landing ticket need the owner raises it, removes entail:cleared, and the issue and each open PR are told it followed the edit", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.forge.open(12, 1);
  await h.pass();
  assert.equal(h.ticket().state, "landing");
  h.runner.script("grade", String(ticket.id), { output: GOOD_GRADE });
  h.runner.script("landing-challenge", String(ticket.id), { output: LANDING_UPHELD });

  h.editIssue({ title: "Count hyphenated words as two", body: "Count `a-b` as two words." });
  h.runner.script("re-check", String(ticket.id), {
    output: recheckOf({ outcome: "needs_the_owner", verdict: "needs_the_owner", vision_check: [{ line: WORD_LINE, mark: "contradicts" }], citations: [], why_raised: "contradiction" }),
  });
  await h.pass(2);

  assert.equal(h.ticket().state, "on-the-board");
  assert.deepEqual(h.forge.merges, []);
  assert.deepEqual(h.forge.state.labels[1], []);
  const item = h.setup.store.openBoardItem(ticket.id)!;
  const snapshot = item.snapshot as BoardItemSnapshot;
  assert.deepEqual([snapshot.ticket.issue.title, snapshot.ticket.request], ["Count hyphenated words as two", "Count `a-b` as two words."], "the item quotes the edited issue");
  const intake = h.forge.commentsOn().at(-1)!;
  assertCommentRules(intake, "Ada", ticket.id);
  assert.match(intake, /This replaces \[entail's earlier intake comment\]\([^)]+\), after the issue was edited\./);
  const [raised, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(raised!, /entail raised #1 to the owner after the issue was edited\./);

  h.setup.store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "dont-go-ahead" });
  await h.pass(2);
  assert.equal(h.ticket().state, "cancelled");
  assert.match(h.forge.prComments(12)[1]!, /The owner decided not to go ahead with #1 after an edit to the issue, so its ticket is cancelled\./);

  // A final ticket: an edit does nothing.
  const calls = h.calls().length;
  h.editIssue({ body: "Count `a-b` as three words." });
  await h.pass();
  assert.equal(h.calls().length, calls);
});

test("a ticket cleared by the owner's answer is re-checked on an edit but keeps the answer: it stands, gets new criteria that still cite it, or raises only the call the answer does not cover", async (t) => {
  const h = await harness(t);
  const { ticket, answerId } = await clearOnAnswer(h);
  const answered = criteriaInForce(h.calls())!;
  assert.deepEqual(answered.answerIds, [answerId]);
  const comments = h.forge.commentsOn().length;

  // 1. It stands, though the run repeats the prior verdict, needs the owner: only its outcome counts, and the answer is not reopened.
  h.editIssue({ body: EDITED });
  h.runner.script("re-check", String(ticket.id), { output: answeredRecheck() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  let call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "stands");
  assert.equal(call.detail.recheck.answered, true);
  assert.equal(call.answerId, answerId, "the call cites the answer");
  assert.equal(call.checks, null, "a call on the owner's answer is no verdict to check");
  assert.equal(h.ticket().state, "cleared");
  assert.equal(criteriaInForce(h.calls())?.version, answered.version);
  assert.equal(h.forge.commentsOn().length, comments);
  const prompt = h.runner.requests.filter((request) => request.kind === "re-check").at(-1)!.prompt;
  assert.match(prompt, /They are the owner's word and they stand: you cannot reopen them/);
  assert.match(prompt, /## The owner's answers \(the owner's word, given on entail's board, oldest first, as JSON\)\n\[\n[^\]]*"answer": "Split words on whitespace only\."/);
  const challenge = h.runner.requests.filter((request) => request.kind === "challenge").at(-1)!.prompt;
  assert.match(challenge, /Split words on whitespace only\./, "the challenge is shown the answer");

  // 2. It goes ahead differently: a new criteria version that still cites the answer, and a comment quoting it again.
  h.editIssue({ body: `${EDITED} Also count \`a.b\` as one word.` });
  h.runner.script("re-check", String(ticket.id), { output: answeredRecheck({ outcome: "goes_ahead_differently" }) });
  h.runner.script("criteria", String(ticket.id), {
    output: { ...ANSWER_CRITERIA, criteria: [...ANSWER_CRITERIA.criteria, { id: "C2", sentence: "`tally` counts `a.b` as one word.", source: { kind: "issue", ref: null }, checks: [], states_reading: null }] },
  });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "goes_ahead_differently");
  const v2 = criteriaInForce(h.calls())!;
  assert.deepEqual([v2.version, v2.verdictCallId, v2.answerIds, v2.goAheadCallId], [answered.version! + 1, call.id, [answerId], answered.goAheadCallId]);
  assert.equal(h.calls(1, "criteria").at(-1)!.answerId, answerId);
  assert.equal(h.ticket().state, "cleared");
  const body = h.forge.commentsOn().at(-1)!;
  assertCommentRules(body, "Ada", ticket.id);
  assert.match(body, /This replaces \[entail's earlier intake comment\]\([^)]+\), after the issue was edited\./);
  assert.match(body, /Split words on whitespace only\./, "the answer is quoted again");
  assert.match(body, /`tally` counts `a\.b` as one word\./);

  // 3. A product call the answer does not cover: a new item for that call alone.
  const R3 = { id: "R3", reading: "Count `a/b` as one word.", observed_outcome: "`tally a/b` prints 1." };
  const R4 = { id: "R4", reading: "Count `a/b` as two words.", observed_outcome: "`tally a/b` prints 2." };
  h.editIssue({ body: `${EDITED} And what about \`a/b\`?` });
  h.runner.script("re-check", String(ticket.id), {
    output: answeredRecheck({ outcome: "needs_the_owner", readings: [R3, R4], open_readings: ["R3", "R4"], reason: "Whether a slash splits words is a new product call." }),
  });
  await h.pass(2);
  call = recheckCall(h);
  assert.equal(call.detail.recheck.outcome, "needs_the_owner");
  assert.equal(h.ticket().state, "on-the-board");
  const [first, second] = h.setup.store.boardItemsForTicket(ticket.id);
  assert.equal(first!.answer?.id, answerId, "the answer stays as given");
  assert.equal(second!.item.whyRaised, "criteria_product_call");
  const options = (second!.item.snapshot as BoardItemSnapshot).form!.options.map((option) => option.reading);
  assert.deepEqual(options, [R3.reading, R4.reading], "only the open call, never the readings the owner already chose between");

  // Going ahead on it writes criteria from both answers.
  const again = h.setup.store.recordAnswer({ boardItemId: second!.item.id, answeredBy: "Ada", shape: "option", optionId: "R1" });
  h.runner.script("criteria", String(ticket.id), { output: ANSWER_CRITERIA });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass(3);
  assert.equal(h.ticket().state, "cleared");
  assert.deepEqual(criteriaInForce(h.calls())?.answerIds, [answerId, again.id]);
});

test("an answered ticket stays unflagged by a vision change, but an edit flags it", async (t) => {
  const h = await harness(t);
  const { ticket } = await clearOnAnswer(h);
  h.editVision(`${VISION}${NEW_LINE}\n`);
  await h.pass(2);
  assert.equal(h.vision.flags.flag(ticket.id), null);
  const settingsId = h.setup.store.latestSettings(h.repo.id)!.id;
  assert.notEqual(recordIssueEdit(h.setup.store, ticket.id, { title: "Count hyphenated and dotted words", body: BODY }, settingsId), null);
  await h.vision.flags.refresh(h.repo);
  const flag = h.vision.flags.flag(ticket.id)!;
  assert.deepEqual(flag.edit?.to, { title: "Count hyphenated and dotted words", body: BODY });
  assert.equal(flag.changes.length, 1, "re-checked at the current vision, with the change since");
});

test("a deciding ticket's verdict run in flight when the issue is edited is discarded, and the ticket decided at the latest text", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1, { title: TITLE, body: BODY })];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("verdict", "1", { output: settled(), until: gate });
  await passUntil(h, "verdict");
  h.editIssue({ body: EDITED });
  await h.engine.runPass();
  release();
  await h.idle();
  assert.deepEqual(h.calls(1, "verdict"), []);
  assert.equal(editCall(h).stateChange, null);

  h.runner.script("verdict", "1", { output: settled() });
  await h.pass();
  const [verdict] = h.calls(1, "verdict");
  assert.equal(verdict?.inputs?.issueBody, EDITED);
  assert.ok(h.runner.requests.filter((request) => request.kind === "verdict").at(-1)!.prompt.includes("Treat `a_b` the same way."));
});

test("a deciding ticket edited after its verdict, before its criteria, is decided again at the latest text", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1, { title: TITLE, body: BODY })];
  h.runner.script("verdict", "1", { output: settled() });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("criteria", "1", { output: SETTLED_CRITERIA, until: gate });
  await passUntil(h, "criteria");
  h.editIssue({ body: EDITED });
  await h.engine.runPass();
  release();
  await h.idle();
  assert.deepEqual(h.calls(1, "criteria"), [], "the criteria run in flight is discarded");

  h.runner.script("verdict", "1", { output: settled() });
  h.runner.script("criteria", "1", { output: SETTLED_CRITERIA });
  h.runner.script("challenge", "1", { output: UPHELD });
  await h.pass(3);
  assert.equal(h.ticket().state, "cleared");
  assert.deepEqual(h.calls(1, "verdict").map((call) => call.inputs?.issueBody), [BODY, EDITED]);
  assert.equal(h.calls(1, "criteria")[0]!.inputs?.issueBody, EDITED);
});

test("an investigating ticket edited before its findings arrive is decided at the text current when they do", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1, { title: TITLE, body: BODY })];
  h.runner.script("verdict", "1", { output: settled({ verdict: "investigate", citations: [], questions: ["Does `a-b` count as two today?"], reason: "Unknown." }) });
  await h.pass();
  assert.equal(h.ticket().state, "investigating");

  h.editIssue({ body: EDITED });
  await h.pass();
  assert.equal(h.ticket().state, "investigating", "nothing happens until findings arrive");
  assert.equal(editCall(h).stateChange, null);

  const investigation = h.calls(1, "investigation")[0]!;
  h.setup.store.recordCall({
    ticketId: h.ticket().id,
    kind: "findings",
    reason: "Findings arrived.",
    detail: {
      investigationCallId: investigation.id,
      comment: { id: 77, url: "https://github.com/acme/tally/issues/1#issuecomment-77", createdAt: "2026-11-09T03:00:00.000Z", author: EXECUTOR, body: "## entail findings\n\nQ1: Yes." },
      questions: [{ id: "Q1", question: "Does `a-b` count as two today?" }],
      entries: [{ id: "Q1", text: "Yes." }],
      unknown: [],
    },
    stateTo: "deciding",
  });
  h.runner.script("verdict", "1", { output: settled() });
  await h.pass();
  const verdicts = h.calls(1, "verdict");
  assert.equal(verdicts.at(-1)!.inputs?.issueBody, EDITED);
});

test("an edit withdraws an open board item, its form locking with the reason, and the ticket is decided again at the latest text", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(1, { title: "Fetch a URL", body: "Count the words of a web page." })];
  const raised = settled({ verdict: "needs_the_owner", citations: [], vision_check: [{ line: "tally never reaches the network.", mark: "contradicts" }], why_raised: "contradiction", reason: "It reaches the network." });
  h.runner.script("verdict", "1", { output: raised });
  await h.pass(2);
  const ticket = h.ticket();
  const item = h.setup.store.openBoardItem(ticket.id)!;

  h.editIssue({ body: "Count the words of a web page saved to a file." });
  h.runner.script("verdict", "1", { output: raised });
  await h.pass(3);

  const history = h.setup.store.boardItem(item.id)!;
  assert.equal(history.withdrawal?.reason, "The issue was edited, and this item's options were written for the old text.");
  const edit = editCall(h);
  assert.deepEqual(edit.stateChange, { from: "on-the-board", to: "deciding" });
  assert.equal(history.withdrawal?.callId, edit.id);
  const verdicts = h.calls(1, "verdict");
  assert.equal(verdicts.length, 2, "decided again");
  assert.equal(verdicts[1]!.inputs?.issueBody, "Count the words of a web page saved to a file.");
  assert.equal(h.ticket().state, "on-the-board");
  assert.equal((h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot).ticket.request, "Count the words of a web page saved to a file.");
});

test("an edit landing just before merge is caught by the merge guard and holds the merge until its re-check is recorded", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  h.forge.open(12, 1);
  await h.pass();
  assert.equal(h.ticket().state, "landing");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("grade", String(ticket.id), { output: GOOD_GRADE, until: gate });
  h.runner.script("landing-challenge", String(ticket.id), { output: LANDING_UPHELD });
  await passUntil(h, "grade");
  // Edited while the landing check runs, with no pass reading it before the merge.
  h.editIssue({ body: EDITED });
  release();
  await h.idle();

  assert.deepEqual(h.forge.merges, [], "the merge guard's re-read caught the edit");
  assert.deepEqual(h.forge.prComments(12), [], "and nothing is posted for the hold");
  assert.equal(h.calls(1, "issue-edit").length, 1, "the edit was recorded first");
  assert.notEqual(await h.vision.flags.flagOf(h.repo, h.ticket()), null);

  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass(3);
  assert.equal(recheckCall(h).detail.recheck.issueEdit?.to.body, EDITED);
  assert.equal(h.calls(1, "issue-edit").length, 1, "the pass reads the same edit as no new one");
  assert.equal(h.ticket().state, "merged");
  assert.equal(h.forge.merges.length, 1);
  assert.equal(h.kinds().filter((kind) => kind === "grade").length, 1, "the criteria version is unchanged, so the grade is reused");
});

test("an edit before a vision change's re-check is recorded restarts it with every change so far", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const sha = h.editVision(`${VISION}${NEW_LINE}\n`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.runner.script("re-check", String(ticket.id), { output: recheckOf(), until: gate });
  await passUntil(h, "re-check");

  h.editIssue({ body: EDITED });
  await h.engine.runPass();
  release();
  await h.idle();
  assert.equal(h.calls(1, "recheck").length, 0, "the re-check in flight is discarded");

  h.runner.script("re-check", String(ticket.id), { output: recheckOf() });
  h.runner.script("challenge", String(ticket.id), { output: UPHELD });
  await h.pass();
  const call = recheckCall(h);
  assert.equal(call.detail.visionChangeIds.length, 1);
  assert.deepEqual(call.detail.recheck.added, [NEW_LINE]);
  assert.equal(call.detail.recheck.issueEdit?.to.body, EDITED);
  assert.match(call.reason, new RegExp(`^Re-checked after the vision change at ${sha.slice(0, 7)} and an edit to the issue: the call stands\\.`));
  const prompt = h.runner.requests.filter((request) => request.kind === "re-check").at(-1)!.prompt;
  assert.match(prompt, /after a change to the vision of record and the issue's title or body\./);
  assert.match(prompt, /- "Counts are exact\." \(origin: owner-stated\)/);
  assert.match(prompt, /## The issue's edit since the prior call/);
});

test("recording an edit is safe to run twice, and does nothing for a final ticket or text that is no edit", async (t) => {
  const h = await harness(t);
  const ticket = await h.clear();
  const settingsId = h.setup.store.latestSettings(h.repo.id)!.id;
  assert.equal(recordIssueEdit(h.setup.store, ticket.id, { title: TITLE, body: `${BODY} ` }, settingsId), null);
  assert.notEqual(recordIssueEdit(h.setup.store, ticket.id, { title: TITLE, body: EDITED }, settingsId), null);
  assert.equal(recordIssueEdit(h.setup.store, ticket.id, { title: TITLE, body: EDITED }, settingsId), null, "the same edit twice");
  h.setup.store.recordCall({ ticketId: ticket.id, kind: "cancel-on-outside-close", reason: "Closed.", stateTo: "cancelled" });
  assert.equal(recordIssueEdit(h.setup.store, ticket.id, { title: "Another title", body: EDITED }, settingsId), null);
  assert.equal(h.calls(1, "issue-edit").length, 1);
});
