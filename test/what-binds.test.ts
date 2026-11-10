import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { challengePrompt, isConcrete, recordedChallenge, type ChallengeOutput, type Objection } from "../src/challenge.ts";
import { checkCriteria, CRITERIA_CHECKS, criteriaPrompt, type CriteriaContext } from "../src/criteria.ts";
import { judgedPins, verdictPrompt, visionText, type JudgedRequest, type RecordedVerdict } from "../src/decider.ts";
import type { CriteriaOutput, VerdictOutput } from "../src/model-schemas.ts";
import type { ScheduledRun } from "../src/model-runs.ts";
import { recheckPrompt } from "../src/recheck.ts";
import { splitVisionLines } from "../src/vision.ts";
import { REPO_CONTENT, WHAT_BINDS } from "../src/what-binds.ts";
import { FIXTURE_DIRECTORY, FIXTURE_ISSUES, FIXTURE_SETTINGS, type FixtureIssue } from "./acceptance/fixture.ts";
import { actor } from "./pass-fixture.ts";

// Only VISION.md and the pins bind (ADR-0021, issue #170), tested on the
// acceptance fixture `tally`: its vision, its pin and its tickets T1–T13.

const TALLY_VISION = readFileSync(join(FIXTURE_DIRECTORY, "VISION.md"), "utf8");
const VISION_LINES = splitVisionLines(TALLY_VISION);
const PINS = judgedPins(FIXTURE_SETTINGS.pins.map((pin) => ({ topic: pin.topic, paths: [...pin.paths], keywords: [] })));
const SHA = "a".repeat(40);

const NETWORK_LINE = "tally never reaches the network.";
const CONFIG_LINE = "tally reads no configuration files; everything it does is set by its command-line flags.";
const WORD_LINE = "A word is a run of characters between whitespace.";
/** A line of a decision record in tally's repo: design history, not the vision. */
const ADR_LINE = "tally is plain Node with no UI framework and no build step.";
const ADR_PATH = "docs/adr/0017-tally-is-plain-node-with-no-ui-framework.md";

function requestOf(issue: Pick<FixtureIssue, "title" | "body">): JudgedRequest {
  const owner = actor(1001);
  return {
    title: issue.title,
    body: issue.body,
    parts: [
      { part: "title", author: owner, text: issue.title },
      { part: "body", author: owner, text: issue.body },
    ],
  };
}

const UNOPPOSED: VerdictOutput = {
  size: { value: "fits", reason: "One change." },
  readings: [{ id: "R1", reading: "Show progress with a UI framework.", observed_outcome: "`tally big.txt` shows a progress bar while it counts." }],
  pins_touched: [],
  vision_check: [{ line: "tally is a small command-line tool that counts the words, lines and characters in text.", mark: "does_not_settle" }],
  verdict: "unopposed",
  citations: [],
  why_unopposed: "No vision line speaks to how tally's display is built.",
  reading_chosen: "R1",
  why_raised: null,
  open_readings: [],
  close_evidence: [],
  questions: [],
  reason: "Nothing in the vision opposes it.",
};
const RECORDED: RecordedVerdict = { ...UNOPPOSED, model: "m", session_id: null, vision_sha: SHA, duration_ms: 0, estimated_cost_usd: null, usage: null, pin_matches: [] };

function objection(fields: Partial<Objection>): Objection {
  return { kind: "contradicted_line", objection: "It goes against what the repo decided.", lines: [], pin: null, reading: null, criterion: null, ...fields };
}

function run(output: ChallengeOutput): ScheduledRun<ChallengeOutput> {
  return { output, facts: { model: "m", sessionId: null, durationMs: 1, estimatedCostUsd: null, usage: null } } as unknown as ScheduledRun<ChallengeOutput>;
}

test("the rule names only the vision and the pins as binding, and the rest of the repo as design history that never makes readings consequential", () => {
  assert.match(WHAT_BINDS, /^Only the vision of record and the pins decide whether a ticket goes ahead or comes to the owner\. Nothing else in the repo binds/);
  assert.ok(WHAT_BINDS.includes(REPO_CONTENT));
  for (const kind of ["decision records", "spec", "docs", "tests", "code"]) assert.ok(REPO_CONTENT.includes(kind), kind);
  assert.match(WHAT_BINDS, /never a line a ticket contradicts, never makes readings consequential, and never narrows or locks what a ticket asks for/);
  assert.match(WHAT_BINDS, /general understanding of what improves the project/);
});

for (const issue of FIXTURE_ISSUES) {
  test(`${issue.id}: every prompt that judges it or writes its criteria says only tally's vision and pins bind`, () => {
    const request = requestOf(issue);
    const verdict = verdictPrompt({ visionSha: SHA, visionLines: VISION_LINES, pins: PINS, pinMatches: [], request });
    const recheck = recheckPrompt({
      visionSha: SHA,
      visionLines: VISION_LINES,
      pins: PINS,
      pinMatches: [],
      request,
      prior: { ...RECORDED },
      removed: [],
      added: [],
      edit: { from: { title: issue.title, body: "" }, to: { title: issue.title, body: issue.body } },
    });
    const challenge = challengePrompt({ visionSha: SHA, vision: visionText(VISION_LINES), pins: PINS, pinMatches: [], request: "[]", verdict: RECORDED, criteria: [] });
    const criteria = criteriaPrompt({ visionSha: SHA, visionLines: VISION_LINES, pins: PINS, request, verdict: RECORDED, genericCriteria: [], fences: [], seenChecks: ["test"] });
    for (const [name, prompt] of [["verdict", verdict], ["re-check", recheck], ["challenge", challenge], ["criteria", criteria]] as const) {
      assert.ok(prompt.includes(WHAT_BINDS), `the ${name} prompt states what binds`);
      assert.ok(prompt.includes(NETWORK_LINE) && prompt.includes(WORD_LINE), `the ${name} prompt shows tally's vision`);
      assert.ok(prompt.includes('"the output format"'), `the ${name} prompt shows tally's pin`);
    }
    assert.ok(verdict.includes(`Only a vision line can be contradicted: a ticket that changes what ${REPO_CONTENT} describe or decided contradicts nothing.`));
    assert.ok(verdict.includes(`What ${REPO_CONTENT} describe or decided never bears on that difference`));
    assert.ok(recheck.includes(`An edit that now asks to overturn something ${REPO_CONTENT} describe or decided goes ahead differently when no vision line opposes it and it touches no pin`));
    assert.ok(challenge.includes(`a ticket that departs from ${REPO_CONTENT} contradicts nothing, so never object on them`));
    assert.ok(challenge.includes("A criterion that requires updating or superseding a record the ticket overturns is not: it follows from the ticket."));
    assert.ok(challenge.includes(`A criterion that locks the ticket in or narrows it to what ${REPO_CONTENT} describe`));
    assert.ok(criteria.includes(`they are never a criterion's source: never lock in or narrow the ticket to what they describe or decided`));
    assert.match(criteria, /list each such record in "records_overturned" with its path and the decision it records, and write a criterion, traced to the issue, that requires updating or superseding it/);
  });
}

test("a challenge still sends the fixture's owner tickets back with what the vision and pins say: T7 and T8's contradicted lines, T9's pin, T13's missed reading", () => {
  const context = { readings: [{ observed_outcome: "`tally` counts text with a non-breaking space as one word." }] };
  // T7: a URL to fetch contradicts "tally never reaches the network."
  assert.equal(isConcrete(objection({ lines: [NETWORK_LINE] }), context), true, "T7");
  // T8: a ~/.tallyrc contradicts the configuration line.
  assert.equal(isConcrete(objection({ lines: [CONFIG_LINE] }), context), true, "T8");
  // T9: renaming in src/format.js touches the output format pin.
  assert.equal(isConcrete(objection({ kind: "touched_pin", pin: "the output format" }), context), true, "T9");
  // T13: the non-breaking space reading the decider missed.
  const missed = objection({ kind: "missed_reading", reading: { reading: "Only ASCII whitespace separates words.", observed_outcome: "`tally` counts text with a non-breaking space as two words." } });
  assert.equal(isConcrete(missed, context), true, "T13");
});

test("what binds is told to the challenger, never enforced by setting aside a quote that is not word for word in VISION.md, which would trade over-asking for a wrong clear", () => {
  // A challenger that misquotes a real vision line still sends the ticket to the owner, as before.
  const misquoted = objection({ lines: ["tally never goes on the network."], objection: "Fetching a URL reaches the network." });
  assert.equal(isConcrete(misquoted), true);
  assert.equal(recordedChallenge(run({ outcome: "overturned", objections: [misquoted], reason: "r" })).overturned, true);
  // The rule lives in the prompt: design history is no line to object on.
  const prompt = challengePrompt({ visionSha: SHA, vision: visionText(VISION_LINES), pins: PINS, pinMatches: [], request: "[]", verdict: RECORDED });
  assert.ok(prompt.includes(`Only a line of VISION.md counts: a ticket that departs from ${REPO_CONTENT} contradicts nothing, so never object on them.`));
});

/** Criteria for a #169-style ticket: a UI framework asked for against ADR 0017, which they supersede. */
function frameworkCriteria(fields: Partial<CriteriaOutput> = {}): CriteriaOutput {
  return {
    outcome: "criteria",
    criteria: [
      {
        id: "C1",
        sentence: "`tally` shows a progress bar, built with a terminal UI framework, while it counts a large file.",
        source: { kind: "issue", ref: null },
        checks: [{ kind: "leaves_path", argument: "VISION.md" }],
        states_reading: "R1",
      },
      {
        id: "C2",
        sentence: "ADR 0017 is superseded by a decision record for the UI framework.",
        source: { kind: "issue", ref: null },
        checks: [{ kind: "changes_path", argument: "docs/adr/**" }],
        states_reading: null,
      },
    ],
    records_overturned: [{ path: ADR_PATH, decision: ADR_LINE }],
    product_call: null,
    ...fields,
  };
}

/** The framework criteria with C2's checks replaced, or with C2 left out when `checks` is null. */
function supersedingWith(checks: CriteriaOutput["criteria"][number]["checks"] | null, fields: Partial<CriteriaOutput> = {}): CriteriaOutput {
  const [c1, c2] = frameworkCriteria(fields).criteria;
  return frameworkCriteria({ ...fields, criteria: checks === null ? [c1!] : [c1!, { ...c2!, checks }] });
}

function criteriaContext(): CriteriaContext {
  return { verdict: RECORDED, visionLines: VISION_LINES, fences: ["VISION.md"], findings: null, answered: false, seenChecks: ["test"] };
}

test("a ticket that overturns a decision record is cleared only with a criterion that updates or supersedes it", () => {
  assert.equal(checkCriteria(frameworkCriteria(), criteriaContext()).passed, true);
  const exact = supersedingWith([{ kind: "changes_path", argument: ADR_PATH }]);
  assert.equal(checkCriteria(exact, criteriaContext()).passed, true, "the record's own path");
  assert.equal(checkCriteria(frameworkCriteria({ records_overturned: [{ path: `./${ADR_PATH}`, decision: ADR_LINE }] }), criteriaContext()).passed, true, "a leading ./");

  const unsuperseded = supersedingWith(null);
  const checks = checkCriteria(unsuperseded, criteriaContext());
  assert.equal(checks.passed, false);
  assert.deepEqual(checks.results.filter((r) => !r.passed).map((r) => r.check), [CRITERIA_CHECKS.recordsSuperseded]);
  assert.match(checks.results.find((r) => r.check === CRITERIA_CHECKS.recordsSuperseded)!.failure!, /overturns “docs\/adr\/0017-tally-is-plain-node-with-no-ui-framework\.md”, but no criterion carries a changes-path check matching it/);

  const elsewhere = supersedingWith([{ kind: "changes_path", argument: "src/**" }]);
  assert.equal(checkCriteria(elsewhere, criteriaContext()).passed, false, "a change elsewhere does not supersede the record");
  const leaves = supersedingWith([{ kind: "leaves_path", argument: "docs/adr/**" }]);
  assert.equal(checkCriteria(leaves, criteriaContext()).passed, false, "leaving the record alone does not supersede it");
  const outside = checkCriteria(frameworkCriteria({ records_overturned: [{ path: "../elsewhere/adr.md", decision: "x" }] }), criteriaContext());
  assert.match(outside.results.find((r) => r.check === CRITERIA_CHECKS.recordsSuperseded)!.failure!, /reaches outside the repository/);

  // A ticket that overturns nothing needs no such criterion.
  const none = supersedingWith(null, { records_overturned: [] });
  assert.equal(checkCriteria(none, criteriaContext()).passed, true);
});
