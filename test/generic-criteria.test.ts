import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeFacts } from "../src/case-book.ts";
import { judgeLanding, LANDING_KIND, landingPrompt, routeLanding, VISION_ONLY_GENERIC_LANDING_SCHEMA, type LandingAnswer, type LandingInputs } from "../src/landing.ts";
import { changeRepoSettings, checkSettingsChange, formatLog, logItems, repoViews } from "../src/owner.ts";
import { callText } from "../src/posts.ts";
import { GENERIC_BASIS, readLog, repoState, type LandingEntry } from "../src/records.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import { checkAgainst } from "../src/schema.ts";
import { harness, landingAnswer, OWNER, REPO, verdict, type Harness } from "./watch-fixture.ts";

/** Per-repo generic criteria (#222): a setting, checked beside the ticket's own criteria at landing and shown on every go. */

const TESTS = "Tests were added or run for the change.";
const CHANGELOG = "CHANGELOG.md has an entry for the change.";
const TICKET = "Words from standard input count toward the same total.";
const HEAD = "1".repeat(40);

const facts = (files: string[]): ForgeFacts => ({
  checks: [{ name: "test", status: "passed", reported: true, url: null }],
  required: [{ name: "test", reported: true }],
  files: files.map((path) => ({ path, status: "modified", previousPath: null, additions: 3, deletions: 0 })),
});

function inputs(overrides: Partial<LandingInputs> = {}): LandingInputs {
  return {
    repo: "acme/tally",
    pr: { number: 4, text: "# Read standard input\n\nCloses #1. Tests added, changelog updated.\n" },
    head: HEAD,
    base: "b".repeat(40),
    issue: { number: 1, text: "# Read standard input\n\ntally only reads files.\n" },
    criteria: [{ criterion: TICKET, basis: "reading: one total" }],
    vision: { text: "# Vision\n\ntally counts words offline.\n", commit: "b".repeat(40) },
    pins: [],
    facts: facts(["src/count.ts"]),
    diff: "diff --git a/src/count.ts b/src/count.ts\n+read stdin\n",
    precedents: [],
    sendBacks: [],
    checkout: "/checkouts/head",
    ...overrides,
  };
}

const answer = (overrides: Partial<LandingAnswer> = {}): LandingAnswer => ({
  call: "merge",
  reason: "It meets everything.",
  solves: { solved: true, evidence: "src/count.ts" },
  criteria: [
    { criterion: TICKET, met: true, evidence: "src/count.ts" },
    { criterion: TESTS, met: true, evidence: "the test check passed" },
  ],
  beyond: [],
  needs_to_change: [],
  product_call: false,
  question: null,
  rests_on: { vision_lines: [], cases: [] },
  ...overrides,
});

test("the settings change takes a list of generic criteria, tidied, and null or an empty list clears them", () => {
  assert.deepEqual(checkSettingsChange({ genericCriteria: ["  Tests   were added ", TESTS, CHANGELOG] }), { genericCriteria: ["Tests were added", TESTS, CHANGELOG] });
  assert.deepEqual(checkSettingsChange({ genericCriteria: [TESTS, TESTS] }), { genericCriteria: [TESTS] }, "a criterion given twice is one");
  assert.deepEqual(checkSettingsChange({ genericCriteria: null }), { genericCriteria: [] });
  assert.deepEqual(checkSettingsChange({ genericCriteria: [] }), { genericCriteria: [] });
  for (const bad of ["tests", [""], ["  "], [3], ["x".repeat(501)], Array.from({ length: 21 }, (_, i) => `criterion ${i}`)]) {
    assert.throws(() => checkSettingsChange({ genericCriteria: bad }), /genericCriteria is a list of up to 20 criteria/u, JSON.stringify(bad).slice(0, 40));
  }
});

test("a repo's generic criteria are set once, logged under the owner's name, shown in its view, and setting the same ones logs nothing", (t) => {
  const h = harness(t);
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).genericCriteria, [], "none until the owner sets some");
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { genericCriteria: [TESTS, CHANGELOG] });
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { genericCriteria: [TESTS, CHANGELOG] });
  assert.deepEqual(repoViews(h.dataDirectory, { owner: OWNER, model: "claude-opus-5-5", effort: "low" })[0]!.genericCriteria, [TESTS, CHANGELOG]);
  changeRepoSettings(h.dataDirectory, REPO, OWNER, { genericCriteria: [] });
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).genericCriteria, []);
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "settings").length, 2);
  const log = formatLog(logItems(h.dataDirectory, []), { repoColumn: false });
  assert.match(log, new RegExp(`Omkar set generic criteria: "${TESTS}"; "${CHANGELOG}"`, "u"));
  assert.match(log, /Omkar set no generic criteria/u);
});

test("the landing prompt lists the generic criteria after the ticket's, says to take their evidence from the forge, and a repo with none is as before", () => {
  const prompt = landingPrompt(inputs({ generic: [TESTS] }));
  assert.match(prompt, new RegExp(`1\\. ${TICKET}[\\s\\S]*2\\. ${TESTS}\\n   \\(Basis: ${GENERIC_BASIS}\\)`, "u"));
  assert.match(prompt, /What the PR's own description says about itself, such as "tests added" or "docs updated", proves nothing/u);
  assert.match(prompt, /that is its evidence: cite it/u);

  const plain = landingPrompt(inputs());
  assert.doesNotMatch(plain, /generic/iu);
  assert.equal(landingPrompt(inputs({ generic: [] })), plain, "an empty list changes nothing");
});

test("a PR with no ticket is checked against the generic criteria too, and has its own schema for them", () => {
  const prompt = landingPrompt(inputs({ issue: null, criteria: [], generic: [TESTS] }));
  assert.match(prompt, /There is no issue, and the only criteria to check are the repo's generic ones\./u);
  assert.match(prompt, new RegExp(`## The repo's generic criteria\\n\\n1\\. ${TESTS}`, "u"));
  assert.match(prompt, /2\. \*\*The criteria\.\*\* Mark each generic criterion below met or unmet/u);
  const ticketless = landingPrompt(inputs({ issue: null, criteria: [] }));
  assert.match(ticketless, /There is no issue and there are no criteria to check\./u);
  assert.match(ticketless, /2\. \*\*The criteria\.\*\* There are none\./u);
  assert.deepEqual(checkAgainst(VISION_ONLY_GENERIC_LANDING_SCHEMA, landingAnswer({ criteria: [{ criterion: TESTS, met: true, evidence: "x" }] })), []);
});

test("the judgment marks the ticket's criteria and then the generic ones, and an unmet generic criterion sends the PR back like any other", async () => {
  const given = inputs({ generic: [TESTS] });
  const runner = new ScriptedRunner().script(LANDING_KIND, "acme/tally#4", {
    output: answer({
      call: "send-back",
      criteria: [
        { criterion: TICKET, met: true, evidence: "src/count.ts" },
        { criterion: TESTS, met: false, evidence: "the PR changes only src/count.ts; no test file changed" },
      ],
      needs_to_change: ["Add or run tests for the change."],
    }),
  });
  const judged = await judgeLanding(runner, given);
  assert.ok(judged.ok);
  assert.equal(judged.call.call, "send-back");
  assert.deepEqual(judged.call.criteria.map((check) => [check.criterion, check.met]), [[TICKET, true], [TESTS, false]]);

  const merge = routeLanding(answer({ criteria: [{ criterion: TICKET, met: true, evidence: "x" }, { criterion: TESTS, met: false, evidence: "none" }] }), { criteria: [{ criterion: TICKET, basis: "" }, { criterion: TESTS, basis: GENERIC_BASIS }], facts: facts(["src/count.ts"]), touched: { vision: false, pins: [] } });
  assert.ok(!merge.ok, "a merge with an unmet generic criterion is not a usable answer");
  const short = routeLanding(answer({ criteria: [{ criterion: TICKET, met: true, evidence: "x" }] }), { criteria: [{ criterion: TICKET, basis: "" }, { criterion: TESTS, basis: GENERIC_BASIS }], facts: facts([]), touched: { vision: false, pins: [] } });
  assert.ok(!short.ok && /marks 1 criteria, but 2 were given/u.test(short.problem), "every generic criterion must be marked");
});

test("a posted go lists the generic criteria before the line on linking the PR, and posts nothing extra in a repo with none", () => {
  const call = verdict({ criteria: [{ source: "reading", criterion: TICKET, basis: "One total." }] });
  const go = { call: "go" as const, reason: call.reason, restsOn: { visionLines: [], cases: [] }, criteria: call.criteria, scope: "implement" as const };
  const text = callText(go as never, false, OWNER, 1, null, [TESTS, CHANGELOG]);
  assert.match(text, new RegExp(`What the PR must do beyond solving the issue:\\n\\n- ${TICKET}\\n- ${TESTS}\\n- ${CHANGELOG}\\n- Link the PR to this issue`, "u"));
  assert.equal(callText(go as never, false, OWNER, 1, null), callText(go as never, false, OWNER, 1, null, []));
  assert.doesNotMatch(callText(go as never, false, OWNER, 1), /Tests were added/u);
});

/** A go made and acted on, then a PR closing it. */
async function goAndPr(h: Harness): Promise<void> {
  h.forge.file(1, "Read standard input", "tally only reads files.");
  h.script(1, verdict({ criteria: [{ source: "reading", criterion: TICKET, basis: "One total is what users see." }] }));
  await h.pass();
}

for (const kind of ["github", "gitlab"] as const) {
  test(`on ${kind}, a go carries the generic criteria and the landing call checks them: unmet sends the PR back, met merges it, and the record keeps them`, async (t) => {
    const h = harness(t, { confirm: false, forge: kind, settings: { start: "my-executor" } });
    changeRepoSettings(h.dataDirectory, h.repo, OWNER, { genericCriteria: [TESTS] });
    const handoffs: { criteria: { criterion: string; source: string }[] }[] = [];
    h.forge.file(1, "Read standard input", "tally only reads files.");
    h.script(1, verdict({ criteria: [{ source: "reading", criterion: TICKET, basis: "One total is what users see." }] }));
    await h.pass({ startWork: async (command, handoff) => { void command; handoffs.push(handoff); return { ok: true, detail: "started" } as never; } });
    assert.match(h.forge.posted[0]!.body, new RegExp(`- ${TICKET}\\n- ${TESTS}\\n- Link the PR`, "u"), "the posted go shows them");
    assert.deepEqual(handoffs[0]!.criteria.map((c) => [c.source, c.criterion]).slice(1, 2), [["owner", TESTS]], "the implementer is handed them");

    h.forge.openPull(4, "Read standard input", { head: HEAD, closes: [1], body: "Closes #1. Tests added, trust me." });
    h.forge.report(HEAD, ["test", "passed"]);
    h.scriptLanding(
      4,
      landingAnswer({
        call: "send-back",
        reason: "No test changed.",
        criteria: [
          { criterion: TICKET, met: true, evidence: "src/count.ts" },
          { criterion: TESTS, met: false, evidence: "only src/count.ts changed, whatever the description says" },
        ],
        needs_to_change: ["Add or run tests."],
      }),
    );
    await h.pass();
    const request = h.runner.requests.find((r) => r.kind === LANDING_KIND)!;
    assert.match(request.prompt, new RegExp(`2\\. ${TESTS}`, "u"));
    assert.match(request.prompt, /Changed files \(1\):/u, "the forge's own facts are in the prompt");
    const [landing] = readLog(h.dataDirectory, h.repo).filter((entry): entry is LandingEntry => entry.type === "landing");
    assert.deepEqual(landing!.criteria.map((c) => c.criterion), [TICKET, TESTS], "the checklist holds the ticket's criteria, then the generic ones");
    assert.equal(landing!.criteria[1]!.source, "owner");
    assert.equal(landing!.call.call, "send-back");
    assert.deepEqual(h.forge.merges, []);
    const post = h.forge.posted.find((p) => p.issue === 4)!;
    assert.match(post.body, new RegExp(`- Met: ${TICKET}\\n- \\*\\*Not met\\*\\*: ${TESTS}`, "u"));
  });

  test(`on ${kind}, a PR meeting the ticket's criterion and the generic one is merged at the judged head, with both marked met in the record`, async (t) => {
    const h = harness(t, { confirm: false, forge: kind });
    changeRepoSettings(h.dataDirectory, h.repo, OWNER, { genericCriteria: [TESTS] });
    await goAndPr(h);
    h.forge.openPull(4, "Read standard input", { head: HEAD, closes: [1], body: "Closes #1." });
    h.forge.report(HEAD, ["test", "passed"]);
    h.scriptLanding(
      4,
      landingAnswer({
        call: "merge",
        criteria: [
          { criterion: TICKET, met: true, evidence: "src/count.ts" },
          { criterion: TESTS, met: true, evidence: "test/count.test.ts changed" },
        ],
      }),
    );
    await h.pass();
    assert.deepEqual(h.forge.merges.map((m) => [m.pr, m.sha]), [[4, HEAD]]);
    const [landing] = readLog(h.dataDirectory, h.repo).filter((entry): entry is LandingEntry => entry.type === "landing");
    assert.equal(landing!.call.call, "merge");
    assert.deepEqual(landing!.call.criteria.map((c) => [c.criterion, c.met]), [[TICKET, true], [TESTS, true]]);
  });
}

test("a repo with no generic criteria lands a PR exactly as it did: the ticket's criteria alone, nothing generic in the prompt or the record", async (t) => {
  const h = harness(t, { confirm: false });
  await goAndPr(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD, closes: [1], body: "Closes #1." });
  h.forge.report(HEAD, ["test", "passed"]);
  h.scriptLanding(4, landingAnswer({ criteria: [{ criterion: TICKET, met: true, evidence: "src/count.ts" }] }));
  await h.pass();
  const request = h.runner.requests.find((r) => r.kind === LANDING_KIND)!;
  assert.doesNotMatch(request.prompt, /generic/iu);
  const [landing] = readLog(h.dataDirectory, h.repo).filter((entry): entry is LandingEntry => entry.type === "landing");
  assert.deepEqual(landing!.criteria.map((c) => c.criterion), [TICKET]);
  assert.equal(h.forge.merges.length, 1);
});
