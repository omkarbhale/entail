import assert from "node:assert/strict";
import { test } from "node:test";
import type { CriteriaDetail } from "../src/criteria.ts";
import type { JudgedPin } from "../src/decider.ts";
import {
  flagBasisOf,
  latestJudgment,
  pinChange,
  pinChangeFlags,
  pinChangeTouchesItem,
  pinsJudgedBy,
  pinsNamedBy,
  visionChangeFlags,
  visionChangeTouchesItem,
  type FlagBasis,
} from "../src/flags.ts";
import { VISION_PIN, type RepoSettings } from "../src/repo-settings.ts";
import type { CallRecord, TicketRecord } from "../src/store.ts";
import { passSetup } from "./pass-fixture.ts";

const CITED = "A word is a run of characters between whitespace.";
const OTHER = "tally never reaches the network.";

function basis(fields: Partial<FlagBasis> = {}): FlagBasis {
  return { state: "cleared", automatic: true, cited: [CITED], ...fields };
}

test("a vision change that adds any line flags a cleared or landing ticket cleared by an automatic verdict", () => {
  const added = { removed: [], added: ["Output is coloured when printed to a terminal."] };
  assert.equal(visionChangeFlags(basis(), added), true);
  assert.equal(visionChangeFlags(basis({ state: "landing" }), added), true);
  // An unopposed clear cites nothing, and a new line can still overturn it (ADR-0016).
  assert.equal(visionChangeFlags(basis({ cited: [] }), added), true);
});

test("a vision change that removes a line the call cites flags the ticket; removing an uncited line does not", () => {
  assert.equal(visionChangeFlags(basis(), { removed: [CITED], added: [] }), true);
  // Lines are compared by identity, with whitespace collapsed (ADR-0003).
  assert.equal(visionChangeFlags(basis(), { removed: ["A word is a run of  characters between whitespace. "], added: [] }), true);
  assert.equal(visionChangeFlags(basis(), { removed: [OTHER], added: [] }), false);
  assert.equal(visionChangeFlags(basis(), { removed: [], added: [] }), false, "a change that only moves lines flags nothing");
});

test("a ticket cleared by the owner's answer is not flagged by a vision change, nor is a ticket that is not cleared or landing", () => {
  const change = { removed: [CITED], added: ["A new line."] };
  assert.equal(visionChangeFlags(basis({ automatic: false }), change), false);
  for (const state of ["deciding", "investigating", "on-the-board", "merged", "cancelled", "declined"] as const) {
    assert.equal(visionChangeFlags(basis({ state }), change), false, state);
  }
});

test("an open board item is touched by an added line, or a removed line its vision check quotes", () => {
  assert.equal(visionChangeTouchesItem([OTHER], { removed: [], added: ["A new line."] }), true);
  assert.equal(visionChangeTouchesItem([OTHER], { removed: [OTHER], added: [] }), true);
  assert.equal(visionChangeTouchesItem([OTHER], { removed: [CITED], added: [] }), false);
});

function call(id: number, fields: Partial<CallRecord>): CallRecord {
  return {
    id,
    ticketId: 1,
    repoId: 1,
    madeAt: `2026-11-09T00:00:0${id}.000Z`,
    kind: "verdict",
    reason: "r",
    citation: null,
    answerId: null,
    noContradictionFound: false,
    checks: null,
    challenge: null,
    inputs: { visionSha: `sha-${id}` },
    detail: null,
    stateChange: null,
    modelRuns: [],
    postedComments: [],
    ...fields,
  };
}

function criteria(fields: Partial<CriteriaDetail> = {}): CriteriaDetail {
  return {
    outcome: "criteria",
    verdictCallId: 1,
    version: 1,
    criteria: [],
    genericCriteria: [],
    settingsVersionId: 1,
    product_call: null,
    verdict: "settled",
    why_unopposed: null,
    reading_chosen: null,
    fences: [],
    ...fields,
  };
}

const TICKET: TicketRecord = { id: 1, repoId: 1, issueNumber: 1, predecessorId: null, takenInAt: "", state: "cleared", stateCallId: 2, stateChangedAt: "" };

test("a ticket's flag is judged against its latest judgment: its clear, or a later re-check, with the citation it carries", () => {
  const clear = call(2, { kind: "criteria", citation: { visionSha: "sha-2", lines: [CITED] }, detail: criteria() });
  const automatic = flagBasisOf(TICKET, [call(1, {}), clear])!;
  assert.deepEqual([automatic.automatic, automatic.cited, automatic.visionSha, automatic.judgment.id], [true, [CITED], "sha-2", 2]);

  const recheck = call(3, { kind: "recheck", citation: { visionSha: "sha-3", lines: [OTHER] }, detail: { recheck: { outcome: "stands" } } });
  const later = flagBasisOf(TICKET, [call(1, {}), clear, recheck])!;
  assert.deepEqual([later.cited, later.visionSha, later.judgment.id], [[OTHER], "sha-3", 3]);

  // A re-check that withdrew a board item is no judgment of a cleared ticket.
  assert.equal(latestJudgment([clear, call(4, { kind: "recheck", detail: { withdrawn: {} } })])?.id, 2);
  // A failed criteria call publishes nothing.
  assert.equal(latestJudgment([call(5, { kind: "criteria", detail: criteria({ version: null }) })]), null);
});

test("a clear written from the owner's answer is not automatic", () => {
  const answered = call(2, { kind: "criteria", answerId: 9, detail: criteria({ answerIds: [9], goAheadCallId: 1 }) });
  assert.equal(flagBasisOf(TICKET, [answered])?.automatic, false);
  assert.equal(visionChangeFlags(flagBasisOf(TICKET, [answered])!, { removed: [], added: ["A new line."] }), false);
});

// Pin changes (spec §12, §15, ADR-0018).

const FORMAT: JudgedPin = { topic: "the output format", paths: ["src/format.js"], keywords: ["format"] };
const NETWORK: JudgedPin = { topic: "network access", paths: [], keywords: ["http"] };

test("a pin is compared whole: editing any part of it is one pin removed and one added, and reordering its paths changes nothing", () => {
  assert.deepEqual(pinChange([FORMAT], [FORMAT]), { removed: [], added: [] });
  const reordered = { ...FORMAT, paths: ["src/format.js", "src/print.js"] };
  assert.deepEqual(pinChange([reordered], [{ ...reordered, topic: " the  output format", paths: ["src/print.js", "src/format.js"] }]), { removed: [], added: [] });
  const edited = { ...FORMAT, keywords: ["format", "printf"] };
  assert.deepEqual(pinChange([FORMAT, NETWORK], [edited, NETWORK]), { removed: [FORMAT], added: [edited] });
  assert.deepEqual(pinChange([FORMAT], [FORMAT, NETWORK]), { removed: [], added: [NETWORK] });
  assert.deepEqual(pinChange([FORMAT, NETWORK], [NETWORK]), { removed: [FORMAT], added: [] });
});

test("adding a pin flags a cleared or landing ticket cleared by an automatic verdict; removing one flags nothing", () => {
  const added = { removed: [], added: [NETWORK] };
  assert.equal(pinChangeFlags(basis(), added), true);
  assert.equal(pinChangeFlags(basis({ state: "landing", cited: [] }), added), true);
  assert.equal(pinChangeFlags(basis(), { removed: [FORMAT], added: [] }), false, "removing a pin flags nothing");
  assert.equal(pinChangeFlags(basis(), { removed: [FORMAT], added: [{ ...FORMAT, paths: [] }] }), true, "an edit adds the new pin");
  assert.equal(pinChangeFlags(basis({ automatic: false }), added), false, "a ticket cleared by the owner's answer is not flagged, as for a vision change");
  for (const state of ["deciding", "investigating", "on-the-board", "merged", "cancelled", "declined"] as const) {
    assert.equal(pinChangeFlags(basis({ state }), added), false, state);
  }
});

test("a pin change touches an open board item when a pin was added, or a pin the item names was removed", () => {
  assert.equal(pinChangeTouchesItem([], { removed: [], added: [NETWORK] }), true);
  assert.equal(pinChangeTouchesItem(["the output format"], { removed: [FORMAT], added: [] }), true);
  assert.equal(pinChangeTouchesItem(["the output format"], { removed: [NETWORK], added: [] }), false);
  assert.equal(pinChangeTouchesItem([], { removed: [], added: [] }), false);
  const named = pinsNamedBy({
    why: {
      kind: "landing_pin",
      tag: "pin",
      text: "t",
      pins: [{ pin: "the output format", why: "w" }],
      contradicted: [],
      failedCheck: null,
      objection: null,
      pinnedPaths: [{ pin: "the output format", glob: "src/format.js", path: "src/format.js" }],
    },
    landing: { pullRequest: 3, url: "u", headSha: "h", landingCallId: 1, paths: [{ pin: "network access", glob: "src/**", path: "src/net.js" }] },
  });
  assert.deepEqual(named, ["the output format", "network access"]);
});

test("the pins a call judged are the pins its inputs recorded, else those of the settings version it recorded", (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const settings = setup.store.latestSettings(repo.id)!;
  const saved = setup.store.saveSettings(repo.id, { ...(settings.settings as RepoSettings), pins: [FORMAT] }, "Ada");
  const vision = { topic: VISION_PIN.topic, paths: [...VISION_PIN.paths], keywords: [] };
  assert.deepEqual(pinsJudgedBy(setup.store, repo.id, { inputs: { pins: [vision, NETWORK] } }), [vision, NETWORK]);
  assert.deepEqual(pinsJudgedBy(setup.store, repo.id, { inputs: { settingsVersionId: saved.id } }), [vision, FORMAT]);
  assert.deepEqual(pinsJudgedBy(setup.store, repo.id, { inputs: { settingsVersionId: settings.id } }), [vision]);
  assert.equal(pinsJudgedBy(setup.store, repo.id, { inputs: { prHeadSha: "h" } }), null);
  assert.equal(pinsJudgedBy(setup.store, repo.id, { inputs: null }), null);
});
