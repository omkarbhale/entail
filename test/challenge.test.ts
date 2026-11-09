import assert from "node:assert/strict";
import { test } from "node:test";
import {
  challengePrompt,
  isConcrete,
  overturns,
  recordedChallenge,
  type ChallengeOutput,
  type Objection,
} from "../src/challenge.ts";
import type { RecordedVerdict } from "../src/decider.ts";
import type { ScheduledRun } from "../src/model-runs.ts";

const KNOWN = [{ observed_outcome: "`tally --json a b` prints two lines of JSON." }];

function objection(fields: Partial<Objection> = {}): Objection {
  return { kind: "missed_reading", objection: "Something is off.", lines: [], pin: null, reading: null, criterion: null, ...fields };
}

function run(output: ChallengeOutput): ScheduledRun<ChallengeOutput> {
  return { output, facts: { model: "m", sessionId: null, durationMs: 1, estimatedCostUsd: null, usage: null } } as unknown as ScheduledRun<ChallengeOutput>;
}

test("a missed reading is concrete only with a reading and an observable outcome the decider did not list", () => {
  const missed = (observed_outcome: string, reading = "Print an array.") => objection({ reading: { reading, observed_outcome } });
  assert.equal(isConcrete(missed("`tally --json a b` prints one JSON array."), { readings: KNOWN }), true);
  assert.equal(isConcrete(objection(), { readings: KNOWN }), false, "no reading at all");
  assert.equal(isConcrete(missed(" "), { readings: KNOWN }), false, "no outcome");
  assert.equal(isConcrete(missed("Same thing", " "), { readings: KNOWN }), false, "no reading");
  assert.equal(isConcrete(missed("`TALLY --json a b` prints  two lines of JSON"), { readings: KNOWN }), false, "the outcome is one the decider already listed");
});

test("a contradicted line, an uncited assumption, a pin and a criterion each need something to point at", () => {
  assert.equal(isConcrete(objection({ kind: "contradicted_line", lines: ["Output is plain text."] })), true);
  assert.equal(isConcrete(objection({ kind: "contradicted_line", lines: [" "] })), false);
  assert.equal(isConcrete(objection({ kind: "uncited_assumption" })), false);
  assert.equal(isConcrete(objection({ kind: "uncited_assumption", lines: ["A word is a run."] })), true);
  assert.equal(isConcrete(objection({ kind: "touched_pin", pin: "the output format" })), true);
  assert.equal(isConcrete(objection({ kind: "touched_pin", pin: null })), false);
  assert.equal(isConcrete(objection({ kind: "criterion_beyond_source", criterion: "C2" }), { criteria: [{ id: "C1" }, { id: "C2" }] }), true);
  assert.equal(isConcrete(objection({ kind: "criterion_beyond_source", criterion: "C9" }), { criteria: [{ id: "C1" }] }), false);
  assert.equal(isConcrete(objection({ kind: "touched_pin", pin: "the output format", objection: "  " })), false, "an objection says something");
});

test("an overturned outcome with no concrete objection does not overturn, and the vague objections are kept apart", () => {
  assert.equal(overturns({ outcome: "overturned", objections: [], reason: "Could be read differently." }), false);
  const vague = objection({ kind: "touched_pin", pin: null });
  const standing = objection({ kind: "contradicted_line", lines: ["Output is plain text."] });
  const recorded = recordedChallenge(run({ outcome: "overturned", objections: [vague, standing], reason: "r" }));
  assert.equal(recorded.overturned, true);
  assert.deepEqual(recorded.objections, [standing]);
  assert.deepEqual(recorded.vague, [vague]);
  const none = recordedChallenge(run({ outcome: "overturned", objections: [vague], reason: "r" }));
  assert.equal(none.overturned, false);
  assert.deepEqual(none.objections, []);
});

test("the challenge prompt asks for a concrete objection and judges a pin by the outcome, not a mention", () => {
  const verdict = { verdict: "unopposed", readings: [], pins_touched: [], vision_check: [], citations: [], why_unopposed: null, reading_chosen: null, reason: "r" } as unknown as RecordedVerdict;
  const prompt = challengePrompt({ visionSha: "a".repeat(40), vision: "V", pins: [], pinMatches: [], request: "[]", verdict });
  assert.doesNotMatch(prompt, /When unsure, it is touched\./);
  assert.match(prompt, /actually alter what the pin names/);
  assert.match(prompt, /not whether it mentions the pin's topic/);
  assert.match(prompt, /differs from the outcome of every reading the verdict lists/);
  assert.match(prompt, /moving code into its own module, has no such reading/);
  assert.match(prompt, /"this could be read differently" without a second reading/);
  assert.match(prompt, /a question must be specific/);
});
