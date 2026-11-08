import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { boardPlanner, type BoardItemSnapshot } from "../src/board-item.ts";
import type { ChallengeOutput } from "../src/challenge.ts";
import {
  CLOSE_CHALLENGE_PROMPT_VERSION,
  CLOSE_CHECKS,
  checkClose,
  closeCommentText,
  commitPermalink,
  findEvidence,
  knownIssues,
  recentCommits,
  type CloseChecks,
  type FoundEvidence,
} from "../src/close-at-intake.ts";
import { assertCommentRules, composeComment } from "../src/comment-rules.ts";
import { deciderPlanner, judgedPins, VERDICT_PROMPT_VERSION, type RecordedVerdict } from "../src/decider.ts";
import type { Issue } from "../src/forge/forge.ts";
import { settleUnconfirmedWrites } from "../src/forge-writer.ts";
import { Mirror } from "../src/mirror.ts";
import type { VerdictOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import type { Pin, RepoSettings } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { RecordedChallenge } from "../src/challenge.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { IntakeForge, issue, passSetup, type PassSetup } from "./pass-fixture.ts";

const VISION = `# tally

tally counts the words of text files.

## Rules

tally never reaches the network.
A word is a run of characters between whitespace.
`;

const ORIGIN = "http://127.0.0.1:7419";
const FORMAT_PIN: Pin = { topic: "the output format", paths: ["src/format.js"], keywords: [] };
const REPO = { forge: "github" as const, host: "github.com", path: "acme/tally" };

/** A proposed close, with every field the verdict schema asks for. */
function close(fields: Partial<VerdictOutput> = {}): VerdictOutput {
  return {
    size: { value: "fits", reason: "One report." },
    readings: [{ id: "R1", reading: "A leading space is not a word.", observed_outcome: "`echo ' a' | tally` prints 1." }],
    pins_touched: [],
    vision_check: [{ line: "A word is a run of characters between whitespace.", mark: "does_not_settle" }],
    verdict: "close",
    citations: [],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: null,
    open_readings: [],
    close_evidence: [{ kind: "duplicate_issue", ref: "3", why: "Issue #3 reports the same off-by-one count." }],
    questions: [],
    reason: "Issue #3 already reports this.",
    ...fields,
  };
}

/** A proposed close as recorded, with what entail adds. */
function recorded(fields: Partial<VerdictOutput> = {}, pinMatches: RecordedVerdict["pin_matches"] = []): RecordedVerdict {
  return {
    ...close(fields),
    model: "claude-opus-5-5",
    session_id: null,
    vision_sha: "f".repeat(40),
    duration_ms: 1,
    estimated_cost_usd: null,
    usage: null,
    pin_matches: pinMatches,
  };
}

const UPHELD: ChallengeOutput = { outcome: "upheld", objections: [], reason: "The other issue asks for the same thing." };

/** A forge whose other issues can be read one by one, as the duplicate check reads them. */
class CloseForge extends IntakeForge {
  readonly others = new Map<number, Issue>();
  readonly issueReads: number[] = [];

  override async issue(issueNumber: number): Promise<Issue | null> {
    this.issueReads.push(issueNumber);
    return this.others.get(issueNumber) ?? this.issues.find((i) => i.number === issueNumber) ?? null;
  }
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

interface Repo {
  fixture: FixtureRepo;
  mirror: Mirror;
  /** The commit adding VISION.md. */
  visionSha: string;
  /** A commit on the default branch fixing the leading-space count. */
  fix: string;
  /** A commit on the default branch changing nothing but VISION.md. */
  visionOnly: string;
  /** The default branch's head. */
  head: string;
  /** A commit only on a PR's head, not on the default branch. */
  elsewhere: string;
}

async function repo(t: TestContext, dataDirectory: string, projectId: number): Promise<Repo> {
  const fixture = new FixtureRepo(t);
  fixture.write("VISION.md", VISION).write("src/format.js", "export const format = (n) => String(n);\n");
  const visionSha = fixture.commit("vision");
  fixture.write("src/count.js", "export const count = (s) => s.trim().split(/\\s+/).length;\n");
  const fix = fixture.commit("Count no word for a leading space");
  fixture.write("VISION.md", `${VISION}\ntally prints one line per file.\n`);
  const visionOnly = fixture.commit("Say how tally prints");
  fixture.push();
  fixture.checkout("-b", "side").write("src/side.js", "export {};\n");
  const elsewhere = fixture.commit("Side work");
  fixture.pushRef(elsewhere, "refs/pull/9/head").checkout("main");
  const mirror = await Mirror.open({
    dataDirectory,
    key: { forge: "github", host: "github.com", projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  const head = (await mirror.updateDefaultBranch()).commit;
  await mirror.fetchPullRequestHead(9);
  return { fixture, mirror, visionSha, fix, visionOnly, head, elsewhere };
}

test("the default branch's recent commits are read newest first with their subjects", async (t) => {
  const setup = passSetup(t);
  const r = await repo(t, setup.dataDirectory, 5001);
  assert.deepEqual(await recentCommits(r.mirror.git, r.head), [
    { sha: r.visionOnly, subject: "Say how tally prints" },
    { sha: r.fix, subject: "Count no word for a leading space" },
    { sha: r.visionSha, subject: "vision" },
  ]);
});

test("the decider is shown the repo's other issues entail took in, newest first, each once, without the one judged", (t) => {
  const setup = passSetup(t);
  const enrolled = setup.enroll();
  const other = setup.enroll({ projectId: 6001, path: "acme/other" });
  const takeIn = (repoId: number, issueNumber: number, title: string) => {
    const ticket = setup.store.takeIn({ repoId, issueNumber, predecessorId: setup.store.latestTicketForIssue(repoId, issueNumber)?.id ?? null });
    setup.store.recordCall({ ticketId: ticket.id, kind: "intake", reason: "taken in", inputs: { issueTitle: title, issueBody: "" } });
  };
  takeIn(enrolled.id, 3, "Counts one too many");
  takeIn(other.id, 4, "Another repo's issue");
  takeIn(enrolled.id, 5, "The issue judged");
  takeIn(enrolled.id, 6, "Colour output");
  assert.deepEqual(knownIssues(setup.store, enrolled.id, 5), [
    { number: 6, title: "Colour output" },
    { number: 3, title: "Counts one too many" },
  ]);
  assert.deepEqual(knownIssues(setup.store, enrolled.id, 5, 1), [{ number: 6, title: "Colour output" }]);
});

test("each piece of evidence is found in the repo: another issue read live, a commit on the default branch", async (t) => {
  const setup = passSetup(t);
  const r = await repo(t, setup.dataDirectory, 5001);
  const forge = new CloseForge();
  forge.others.set(3, issue(3, { title: "Counts one too many" }));
  const found = await findEvidence({ forge, git: r.mirror.git, repo: REPO, head: r.head, issueNumber: 5, ticketState: () => null }, [
    { kind: "duplicate_issue", ref: "#3", why: "Same report." },
    { kind: "duplicate_issue", ref: "404", why: "Gone." },
    { kind: "duplicate_issue", ref: "5", why: "Itself." },
    { kind: "duplicate_issue", ref: "the other one", why: "Vague." },
    { kind: "fixing_commit", ref: r.fix.slice(0, 10), why: "Fixed." },
    { kind: "fixing_commit", ref: r.elsewhere, why: "Side." },
    { kind: "fixing_commit", ref: "deadbeefdeadbeef", why: "Unknown." },
    { kind: "fixing_commit", ref: "HEAD~1", why: "Not a sha." },
  ]);
  assert.deepEqual(forge.issueReads, [3, 404], "only well-formed other issues are read");

  const [dup, gone, itself, vague, fixed, side, unknown, notSha] = found as [FoundEvidence, ...FoundEvidence[]];
  assert.equal(dup.missing, null);
  assert.ok(dup.kind === "duplicate_issue" && dup.issue?.number === 3 && dup.issue.url === "https://github.com/acme/tally/issues/3");
  assert.equal(gone!.missing, "This repo has no issue #404.");
  assert.equal(itself!.missing, "It names this issue, #5, as its own duplicate.");
  assert.equal(vague!.missing, "“the other one” is not an issue number.");
  assert.ok(fixed !== undefined && fixed.kind === "fixing_commit" && fixed.missing === null);
  assert.deepEqual(fixed.commit, {
    sha: r.fix,
    subject: "Count no word for a leading space",
    message: "Count no word for a leading space",
    paths: ["src/count.js"],
    url: `https://github.com/acme/tally/commit/${r.fix}`,
  });
  assert.equal(side!.missing, `Commit ${r.elsewhere.slice(0, 7)} is not on the default branch at ${r.head.slice(0, 7)}.`);
  assert.equal(unknown!.missing, "No commit deadbeefdeadbeef is in the repo.");
  assert.equal(notSha!.missing, "“HEAD~1” is not a commit sha.");
});

test("a commit is linked on each forge", () => {
  assert.equal(commitPermalink(REPO, "abc"), "https://github.com/acme/tally/commit/abc");
  assert.equal(commitPermalink({ forge: "gitlab", host: "git.example.com", path: "g/s/p" }, "abc"), "https://git.example.com/g/s/p/-/commit/abc");
});

test("a close whose evidence exists, resting on the repo's state with no pin touched, passes its checks", () => {
  const dup: FoundEvidence = {
    kind: "duplicate_issue",
    ref: "3",
    why: "Same.",
    issue: { number: 3, title: "t", body: "b", state: "open", url: "u" },
    missing: null,
  };
  const checks = checkClose(recorded(), [dup]);
  assert.equal(checks.passed, true);
  assert.deepEqual(
    checks.results.map((r) => [r.check, r.passed]),
    [
      [CLOSE_CHECKS.noPin, true],
      [CLOSE_CHECKS.restsOnRepoState, true],
      [CLOSE_CHECKS.evidenceExists, true],
    ],
  );
  assert.deepEqual(checks.evidence, [dup]);
  assert.throws(() => checkClose(recorded({ verdict: "unopposed" }), [dup]), /only a proposed close/);
});

test("a proposed close resting only on the vision is rejected by the checks", () => {
  const noEvidence = checkClose(
    recorded({ close_evidence: [], vision_check: [{ line: "tally never reaches the network.", mark: "contradicts" }] }),
    [],
  );
  assert.equal(noEvidence.passed, false);
  const rests = noEvidence.results.find((r) => r.check === CLOSE_CHECKS.restsOnRepoState)!;
  assert.equal(rests.passed, false);
  assert.match(rests.failure!, /cites no evidence from the repo's state, so it would rest on the vision alone/);
  assert.match(rests.failure!, /“tally never reaches the network\.” as contradicted: a request the vision opposes needs the owner/);

  const visionCommit: FoundEvidence = {
    kind: "fixing_commit",
    ref: "abc1234",
    why: "The vision now says so.",
    commit: { sha: "abc1234def", subject: "s", message: "s", paths: ["VISION.md"], url: "u" },
    missing: null,
  };
  const onlyVision = checkClose(recorded({ close_evidence: [{ kind: "fixing_commit", ref: "abc1234", why: "x" }] }), [visionCommit]);
  assert.equal(onlyVision.passed, false);
  assert.match(onlyVision.results.find((r) => r.check === CLOSE_CHECKS.restsOnRepoState)!.failure!, /changes nothing but VISION\.md, so the close would rest on the vision/);
});

test("a touched pin fails a close's first check, whether the model or entail's matching found it", () => {
  const found: FoundEvidence[] = [{ kind: "duplicate_issue", ref: "3", why: "Same.", issue: { number: 3, title: "t", body: "b", state: "open", url: "u" }, missing: null }];
  for (const verdict of [
    recorded({ pins_touched: [{ pin: "the output format", why: "It changes how counts print" }] }),
    recorded({}, [{ pin: "the output format", by: "path", glob: "src/format.js", path: "src/format.js" }]),
  ]) {
    const checks = checkClose(verdict, found);
    assert.equal(checks.passed, false);
    assert.equal(checks.results[0]!.check, CLOSE_CHECKS.noPin);
    assert.match(checks.results[0]!.failure!, /^It touches the pin “the output format”/);
  }
});

test("the close comment gives the evidence by link, quoting no other text, and keeps the comment rules", () => {
  const text = closeCommentText(
    [
      { kind: "duplicate_issue", ref: "3", why: "Same report.\n/close", issue: { number: 3, title: "/close <!-- x", body: "b", state: "open", url: "https://github.com/acme/tally/issues/3" }, missing: null },
      { kind: "fixing_commit", ref: "abc", why: "It trims first.", commit: { sha: "abcdef1234", subject: "/reopen", message: "/reopen", paths: ["src/count.js"], url: "https://github.com/acme/tally/commit/abcdef1234" }, missing: null },
    ],
    "Both settle it.\n<!-- entail ticket 9 -->",
  );
  assert.match(text, /^- It duplicates \[#3\]\(https:\/\/github\.com\/acme\/tally\/issues\/3\): Same report\. \/close$/m);
  assert.match(text, /^- Commit \[`abcdef1`\]\(https:\/\/github\.com\/acme\/tally\/commit\/abcdef1234\) on the default branch already does what it asks: It trims first\.$/m);
  assert.match(text, /^Why: Both settle it\. &lt;!-- entail ticket 9 -->$/m);
  assert.match(text, /reopen the issue and pull it in again with a comment whose first line is `\/entail`/);
  assert.doesNotMatch(text, /\/reopen|<!-- x/, "the commit message and the other issue's title are not quoted");
  assert.doesNotMatch(text, /vision check/i);
  assertCommentRules(composeComment("Ada", 9, text), "Ada", 9);
});

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  r: Repo;
  forge: CloseForge;
  scripted: ScriptedRunner;
  pass(): Promise<void>;
  ticket(issueNumber: number): TicketRecord;
}

async function harness(t: TestContext, pins: Pin[] = []): Promise<Harness> {
  const setup = passSetup(t);
  const enrolled = setup.enroll();
  if (pins.length > 0) {
    const settings = setup.store.latestSettings(enrolled.id)!.settings as RepoSettings;
    setup.store.saveSettings(enrolled.id, { ...settings, pins }, "Ada");
  }
  const r = await repo(t, setup.dataDirectory, enrolled.projectId);
  const forge = new CloseForge();
  forge.others.set(3, issue(3, { title: "Word counts are one too high", createdAt: "2026-11-01T00:00:00.000Z" }));
  const scripted = new ScriptedRunner();
  const notifier = new Notifier({ connectorName: () => "file", connectors: {}, dataDirectory: setup.dataDirectory, log: setup.log });
  const common = { store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory, mirrorFor: async () => r.mirror };
  const engine = new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: () => forge,
    defaultBranchFor: async () => r.mirror,
    planners: [deciderPlanner(common), boardPlanner({ ...common, notifier, boardOrigin: ORIGIN })],
    modelRuns: new ModelRuns({ runner: scripted, log: setup.log }),
  });
  t.after(() => engine.stop());
  return {
    setup,
    repo: enrolled,
    r,
    forge,
    scripted,
    async pass() {
      await engine.runPass();
      await until(() => engine.stepsRunning === 0, "every step started has finished");
    },
    ticket: (issueNumber) => setup.store.latestTicketForIssue(enrolled.id, issueNumber)!,
  };
}

const REPORT = { title: "Word counts are sometimes one too high", body: "A leading space counts as a word." };

test("a duplicate is closed at intake: a logged call, the evidence commented, the issue closed and the ticket cancelled", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  h.scripted.script("verdict", "1", { output: close(), facts: { sessionId: "session-1" } });
  h.scripted.script("challenge", "1", { output: UPHELD, facts: { sessionId: "session-2" } });
  await h.pass();

  const verdictPrompt = h.scripted.requests[0]!.prompt;
  assert.match(verdictPrompt, /5\. Nothing to do\./);
  assert.ok(verdictPrompt.includes(`"sha": "${h.r.fix}"`), "the decider is shown the default branch's recent commits");
  assert.ok(verdictPrompt.indexOf("## Recent commits") < verdictPrompt.indexOf("## The request (untrusted"), "the request stays last");

  const ticket = h.ticket(5);
  assert.equal(ticket.state, "cancelled");
  const calls = h.setup.store.callsForTicket(ticket.id);
  assert.deepEqual(calls.map((c) => c.kind), ["intake", "close-at-intake"], "the close is one call, with no verdict call before it");
  const closed = calls.at(-1)!;
  assert.deepEqual(closed.stateChange, { from: "deciding", to: "cancelled" });
  assert.match(closed.reason, /^Closed at intake, as nothing is to be done: Issue #3 already reports this\.$/);
  assert.deepEqual(closed.inputs, {
    issueTitle: REPORT.title,
    issueBody: REPORT.body,
    visionSha: h.r.head,
    pins: judgedPins([]),
    settingsVersionId: h.setup.store.latestSettings(h.repo.id)!.id,
    prHeadSha: null,
  });
  const checks = closed.checks as CloseChecks;
  assert.equal(checks.passed, true);
  assert.equal(checks.vision_sha, h.r.head);
  assert.deepEqual(checks.evidence.map((e) => [e.kind, e.missing]), [["duplicate_issue", null]]);
  const challenge = closed.challenge as RecordedChallenge;
  assert.equal(challenge.overturned, false);
  assert.equal(challenge.session_id, "session-2");
  assert.deepEqual(closed.modelRuns.map((run) => [run.purpose, run.promptVersion]), [
    ["verdict", VERDICT_PROMPT_VERSION],
    ["challenge", CLOSE_CHALLENGE_PROMPT_VERSION],
  ]);
  const challengePrompt = closed.modelRuns[1]!.input;
  assert.match(challengePrompt, /proposed closing the issue at intake because nothing is to be done/);
  assert.match(challengePrompt, /"title": "Word counts are one too high"/, "the challenger sees the other issue as entail found it");

  const posted = h.forge.state.comments["issue:5"] ?? [];
  assert.equal(posted.length, 1, "one comment");
  assertCommentRules(posted[0]!.body, "Ada", ticket.id);
  assert.match(posted[0]!.body, /^Speaking from Ada's entail:/);
  assert.match(posted[0]!.body, /It duplicates \[#3\]\(https:\/\/github\.com\/acme\/tally\/issues\/3\): Issue #3 reports the same off-by-one count\./);
  assert.doesNotMatch(posted[0]!.body, /vision check/i, "a close gives its evidence, with no vision check");
  assert.equal(closed.postedComments.length, 1, "the comment is recorded on the close call");
  assert.deepEqual(h.forge.state.closed, { 5: "not-planned" }, "a duplicate is closed as not planned");
  assert.deepEqual(h.forge.state.sends, { comment: 1, addLabel: 0, removeLabel: 0, close: 1, merge: 0 });
  assert.equal(h.setup.store.openBoardItem(ticket.id), null, "no board item");
  assert.ok(h.setup.logLines().some((line) => line.event === "ticket-closed-at-intake"));

  await h.pass();
  assert.equal(h.scripted.requests.length, 2, "a cancelled ticket runs nothing again");
  assert.equal(h.forge.state.sends.comment, 1);
});

test("a report the default branch already fixes is closed as completed, linking the fixing commit", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  h.scripted.script("verdict", "1", {
    output: close({ close_evidence: [{ kind: "fixing_commit", ref: h.r.fix, why: "It no longer counts a leading space." }] }),
  });
  h.scripted.script("challenge", "1", { output: UPHELD });
  await h.pass();

  assert.equal(h.ticket(5).state, "cancelled");
  const body = h.forge.state.comments["issue:5"]![0]!.body;
  assert.ok(body.includes(`Commit [\`${h.r.fix.slice(0, 7)}\`](https://github.com/acme/tally/commit/${h.r.fix}) on the default branch already does what it asks`));
  assert.deepEqual(h.forge.state.closed, { 5: "completed" });
});

test("a successful challenge on a proposed close raises the ticket to the board, and nothing is closed", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  h.scripted.script("verdict", "1", { output: close() });
  const overturned: ChallengeOutput = {
    outcome: "overturned",
    objections: [
      {
        kind: "missed_reading",
        objection: "Issue #3 is about a trailing space; this one asks about a leading space",
        lines: [],
        pin: null,
        reading: { reading: "Leading spaces count as no word.", observed_outcome: "`echo ' a' | tally` prints 1." },
        criterion: null,
      },
    ],
    reason: "The other issue asks for something different.",
  };
  h.scripted.script("challenge", "1", { output: overturned });
  await h.pass();

  let ticket = h.ticket(5);
  assert.equal(ticket.state, "deciding", "left deciding for the board's step");
  const proposal = h.setup.store.callsForTicket(ticket.id).at(-1)!;
  assert.equal(proposal.kind, "verdict");
  assert.equal((proposal.detail as RecordedVerdict).verdict, "close");
  assert.equal((proposal.checks as CloseChecks).passed, true);
  assert.equal((proposal.challenge as RecordedChallenge).overturned, true);

  await h.pass();
  ticket = h.ticket(5);
  assert.equal(ticket.state, "on-the-board");
  const item = h.setup.store.openBoardItem(ticket.id)!;
  const snapshot = item.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.kind, "challenge");
  assert.match(snapshot.why.text, /trailing space/);
  assert.ok(snapshot.form.options.some((o) => o.reading === "Leading spaces count as no word."), "the missed reading is offered");
  assert.deepEqual(h.forge.state.closed, {}, "the issue is not closed");
  assert.equal(h.forge.state.comments["issue:5"]!.length, 1, "only the raise's intake comment");
});

test("a touched pin overrides a proposed close: no challenge runs, and the ticket is raised with the pin named", async (t) => {
  const h = await harness(t, [FORMAT_PIN]);
  h.forge.issues = [issue(5, { title: "Counts print wrong", body: "src/format.js prints one too many." })];
  h.scripted.script("verdict", "1", { output: close() });
  await h.pass();
  await h.pass();

  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"], "a failed check runs no challenge");
  const ticket = h.ticket(5);
  assert.equal(ticket.state, "on-the-board");
  const verdictCall = h.setup.store.callsForTicket(ticket.id).find((c) => c.kind === "verdict")!;
  const checks = verdictCall.checks as CloseChecks;
  assert.equal(checks.passed, false);
  assert.equal(checks.results[0]!.check, CLOSE_CHECKS.noPin);
  assert.equal(verdictCall.challenge, null);
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.kind, "failed_check");
  assert.deepEqual(snapshot.why.pins.map((p) => p.pin), ["the output format"]);
  assert.equal(snapshot.why.failedCheck?.check, CLOSE_CHECKS.noPin);
  assert.deepEqual(h.forge.state.closed, {});
});

test("a proposed close resting only on the vision is raised to the owner, never closed", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, { title: "Count the words of a web page", body: "tally https://example.com" })];
  h.scripted.script("verdict", "1", {
    output: close({ close_evidence: [], vision_check: [{ line: "tally never reaches the network.", mark: "contradicts" }], reason: "The vision rules this out." }),
  });
  await h.pass();
  await h.pass();

  assert.deepEqual(h.scripted.requests.map((r) => r.kind), ["verdict"]);
  const ticket = h.ticket(5);
  assert.equal(ticket.state, "on-the-board");
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.failedCheck?.check, CLOSE_CHECKS.restsOnRepoState);
  assert.match(snapshot.why.text, /would rest on the vision alone/);
  assert.deepEqual(h.forge.state.closed, {});
});

test("evidence that does not exist sends the proposed close to the board", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  h.scripted.script("verdict", "1", { output: close({ close_evidence: [{ kind: "fixing_commit", ref: h.r.elsewhere, why: "Fixed on a branch." }] }) });
  await h.pass();
  await h.pass();

  const ticket = h.ticket(5);
  assert.equal(ticket.state, "on-the-board");
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.failedCheck?.check, CLOSE_CHECKS.evidenceExists);
  assert.match(snapshot.why.text, /is not on the default branch/);
  assert.deepEqual(h.forge.state.closed, {});
});

test("a close whose comment failed to post is settled on the next start: the comment once, then the close", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  h.scripted.script("verdict", "1", { output: close() });
  h.scripted.script("challenge", "1", { output: UPHELD });
  const post = h.forge.postComment.bind(h.forge);
  h.forge.postComment = async () => {
    throw new Error("the forge did not answer");
  };
  await h.pass();
  const ticket = h.ticket(5);
  assert.equal(ticket.state, "cancelled", "the call is recorded even though the comment failed");
  assert.deepEqual(h.forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 });

  h.forge.postComment = post;
  const settled = await settleUnconfirmedWrites(h.setup.store, () => h.forge);
  assert.deepEqual(settled.map((s) => [s.kind, "settled" in s ? s.settled : s.error.message]), [
    ["comment", "not found, so posted"],
    ["close", "applied again"],
  ]);
  assert.equal(h.forge.state.comments["issue:5"]!.length, 1);
  assert.deepEqual(h.forge.state.closed, { 5: "not-planned" });
});

function endTicket(h: Harness, issueNumber: number, state: "cancelled" | "declined"): void {
  const ticket = h.setup.store.takeIn({ repoId: h.repo.id, issueNumber, predecessorId: null });
  h.setup.store.recordCall({ ticketId: ticket.id, kind: "intake", reason: "taken in", inputs: { issueTitle: "Earlier", issueBody: "" } });
  h.setup.store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "Ended.", stateTo: state });
}

async function raisedFor(h: Harness, pattern: RegExp): Promise<void> {
  const earlier = h.setup.store.latestTicketForIssue(h.repo.id, 3);
  h.scripted.script("verdict", earlier === null ? "1" : "2", { output: close() });
  await h.pass();
  await h.pass();
  const ticket = h.ticket(5);
  assert.equal(ticket.state, "on-the-board");
  assert.equal(h.scripted.requests.length, 1, "no challenge runs");
  const snapshot = h.setup.store.openBoardItem(ticket.id)!.snapshot as BoardItemSnapshot;
  assert.equal(snapshot.why.failedCheck?.check, CLOSE_CHECKS.evidenceExists);
  assert.match(snapshot.why.text, pattern);
  assert.deepEqual(h.forge.state.closed, {});
}

test("a duplicate of a closed issue fails the evidence check and is raised to the board", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  h.forge.others.set(3, issue(3, { title: "Word counts are one too high", state: "closed" }));
  await raisedFor(h, /Issue #3 is not open/);
});

test("a duplicate whose latest entail ticket was declined fails the evidence check and is raised to the board", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  endTicket(h, 3, "declined");
  await raisedFor(h, /entail declined its latest ticket/);
});

test("mutual duplicates: an issue closed at intake as a duplicate cannot be the target of its target's close", async (t) => {
  const h = await harness(t);
  h.forge.issues = [issue(5, REPORT)];
  endTicket(h, 3, "cancelled");
  await raisedFor(h, /entail cancelled its latest ticket/);
});
