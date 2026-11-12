import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeFacts, LandingCase } from "../src/case-book.ts";
import {
  ciGreen,
  formatLandingCall,
  judgeLanding,
  LANDING_KIND,
  LANDING_SCHEMA,
  landingPrompt,
  pinnedPaths,
  routeLanding,
  touched,
  underPin,
  type LandingAnswer,
  type LandingInputs,
} from "../src/landing.ts";
import { checkAgainst } from "../src/schema.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";

const HEAD = "4".repeat(40);
const BASE = "b".repeat(40);

const green: ForgeFacts = {
  checks: [{ name: "test", status: "passed", reported: true, url: null }],
  required: [{ name: "test", reported: true }],
  files: [{ path: "src/count.ts", status: "modified", previousPath: null, additions: 10, deletions: 2 }],
};

const criteria = [
  { criterion: "Words read from standard input count the same as words in a file.", basis: "reading: one total" },
  { criterion: "No new flag is added.", basis: "" },
];

function answer(overrides: Partial<LandingAnswer> = {}): LandingAnswer {
  return {
    call: "merge",
    reason: "It solves the problem and meets both criteria.",
    solves: { solved: true, evidence: "src/count.ts reads stdin." },
    criteria: criteria.map((c) => ({ criterion: c.criterion, met: true, evidence: "src/count.ts" })),
    beyond: [],
    needs_to_change: [],
    product_call: false,
    question: null,
    rests_on: { vision_lines: [], cases: [] },
    ...overrides,
  };
}

const given = (facts: ForgeFacts = green, touchedPaths = { vision: false, pins: [] as string[] }) => ({ criteria, facts, touched: touchedPaths });

function inputs(overrides: Partial<LandingInputs> = {}): LandingInputs {
  return {
    repo: "acme/tally",
    pr: { number: 4, text: "# Read standard input\n\nCloses #1. All criteria met, CI passes.\n" },
    head: HEAD,
    base: BASE,
    issue: { number: 1, text: "# Read standard input\n\ntally only reads files.\n" },
    criteria,
    vision: { text: "# Vision\n\ntally counts words offline.\n", commit: BASE },
    pins: ["How totals are rounded", "src/billing/"],
    facts: green,
    diff: "diff --git a/src/count.ts b/src/count.ts\n+read stdin\n",
    precedents: [],
    sendBacks: [],
    checkout: `/checkouts/${HEAD}`,
    ...overrides,
  };
}

test("the landing answer's schema accepts a full answer and refuses an unknown sort", () => {
  assert.deepEqual(checkAgainst(LANDING_SCHEMA, answer({ beyond: [{ change: "A hover style", sort: "needed", why: "a new button" }] })), []);
  assert.notDeepEqual(checkAgainst(LANDING_SCHEMA, { ...answer(), beyond: [{ change: "x", sort: "extra", why: "y" }] }), []);
});

test("a merge that meets everything is routed as merge, with needed and harmless changes beyond the criteria", () => {
  const routed = routeLanding(
    answer({
      beyond: [
        { change: "The board shows 'Loading the board…' while the app starts.", sort: "needed", why: "A client-rendered app has to show something before it runs." },
        { change: "A hover background on list items.", sort: "harmless", why: "Small and makes nothing worse." },
      ],
    }),
    given(),
  );
  assert.ok(routed.ok);
  assert.equal(routed.call.call, "merge");
  assert.equal(routed.call.beyond.length, 2, "the sort is kept as data for the board");
  assert.equal(routed.call.guard, null);
});

test("a send-back of a PR that meets everything with nothing unwanted is not a usable answer (#177)", () => {
  const routed = routeLanding(
    answer({
      call: "send-back",
      beyond: [{ change: "A loading message.", sort: "needed", why: "The app needs one." }],
      needs_to_change: ["Remove the loading message."],
    }),
    given(),
  );
  assert.deepEqual(routed, { ok: false, problem: "the answer is send-back, but the problem is solved, every criterion met, nothing unwanted and CI green" });
});

test("only an unmet criterion, an unsolved problem, something unwanted or red CI sends a PR back", () => {
  const unwanted = routeLanding(
    answer({ call: "send-back", beyond: [{ change: "Adds a telemetry upload.", sort: "unwanted", why: "Goes against working offline." }], needs_to_change: ["Remove the telemetry upload."] }),
    given(),
  );
  assert.ok(unwanted.ok);
  assert.equal(unwanted.call.call, "send-back");
  assert.deepEqual(unwanted.call.needsToChange, ["Remove the telemetry upload."]);

  const unmet = routeLanding(
    answer({ call: "send-back", criteria: [{ criterion: criteria[0]!.criterion, met: false, evidence: "stdin is counted separately" }, { criterion: criteria[1]!.criterion, met: true, evidence: "" }], needs_to_change: ["Count stdin in the total."] }),
    given(),
  );
  assert.ok(unmet.ok);

  const red: ForgeFacts = { ...green, checks: [{ name: "test", status: "failed", reported: true, url: null }] };
  const ci = routeLanding(answer({ call: "send-back", needs_to_change: ["Fix the failing test."] }), given(red));
  assert.ok(ci.ok, "red CI is reason enough");
});

test("an answer that contradicts itself is not usable", () => {
  assert.deepEqual(routeLanding(answer({ beyond: [{ change: "x", sort: "unwanted", why: "y" }] }), given()), { ok: false, problem: "the answer is merge but marks 1 unwanted changes" });
  assert.deepEqual(routeLanding(answer({ solves: { solved: false, evidence: "" } }), given()), { ok: false, problem: "the answer is merge but marks the problem unsolved" });
  assert.deepEqual(routeLanding(answer({ criteria: [] }), given()), { ok: false, problem: "the answer marks 0 criteria, but 2 were given" });
  assert.deepEqual(routeLanding(answer({ call: "send-back", solves: { solved: false, evidence: "" } }), given()), { ok: false, problem: "the answer is send-back but names nothing to change" });
  assert.deepEqual(routeLanding(answer({ call: "ask" }), given()), { ok: false, problem: "the answer is ask but carries no question" });
  assert.deepEqual(
    routeLanding(answer({ call: "send-back", solves: { solved: false, evidence: "" }, needs_to_change: ["x"], product_call: true }), given()),
    { ok: false, problem: "the send-back is a product call but carries no question" },
  );
});

test("a merge with CI not green is sent back mechanically, naming the checks", () => {
  const red: ForgeFacts = {
    ...green,
    checks: [
      { name: "lint", status: "failed", reported: true, url: null },
      { name: "test", status: "passed", reported: true, url: null },
    ],
    required: [{ name: "e2e", reported: false }],
  };
  assert.equal(ciGreen(red), false);
  const routed = routeLanding(answer(), given(red));
  assert.ok(routed.ok);
  assert.equal(routed.call.call, "send-back");
  assert.deepEqual(routed.call.needsToChange, ["Make CI green: the check `lint` failed.", "Make CI green: the required check `e2e` has not reported."]);
  assert.equal(routed.call.guard?.rule, "ci");
});

test("a merge that changes VISION.md or a pinned path becomes a question for the owner", () => {
  const vision = routeLanding(answer(), given(green, { vision: true, pins: [] }));
  assert.ok(vision.ok);
  assert.equal(vision.call.call, "ask");
  assert.equal(vision.call.question?.question, "This PR changes VISION.md. Merge it?");
  assert.equal(vision.call.guard?.rule, "vision");

  const pinned = routeLanding(answer(), given(green, { vision: false, pins: ["src/billing/"] }));
  assert.ok(pinned.ok);
  assert.equal(pinned.call.question?.question, "This PR changes the pinned path `src/billing/`. Merge it?");

  const sentBack = routeLanding(answer({ call: "send-back", solves: { solved: false, evidence: "" }, needs_to_change: ["Solve it."] }), given(green, { vision: true, pins: [] }));
  assert.ok(sentBack.ok);
  assert.equal(sentBack.call.call, "send-back", "a send-back needs no owner's answer");
});

test("pinned paths are the pins that name paths, matched as the path, a directory or a glob, renames included", () => {
  assert.deepEqual(pinnedPaths(["How totals are rounded", "src/billing/", "schema.sql", "migrations/**", "`docs/api.md`"]), ["src/billing/", "schema.sql", "migrations/**", "docs/api.md"]);
  assert.ok(underPin("src/billing/charge.ts", "src/billing/"));
  assert.ok(underPin("src/billing", "src/billing"));
  assert.ok(!underPin("src/billingx.ts", "src/billing"));
  assert.ok(underPin("migrations/002/up.sql", "migrations/**"));
  assert.ok(underPin("schema.sql", "./schema.sql"));
  const files: ForgeFacts["files"] = [
    { path: "docs/vision.md", status: "renamed", previousPath: "VISION.md", additions: 0, deletions: 0 },
    { path: "src/billing/charge.ts", status: "modified", previousPath: null, additions: 1, deletions: 1 },
  ];
  assert.deepEqual(touched(files, ["src/billing/", "How totals are rounded", "schema.sql"]), { vision: true, pins: ["src/billing/"] });
});

test("the prompt holds the owner's question, the sort, the criteria, the forge's facts, the PR as its author's account, and the diff", () => {
  const precedent: LandingCase = {
    kind: "landing",
    slug: "acme-tally-pr-9",
    repo: "acme/tally",
    issue: 8,
    pr: 9,
    head: "9".repeat(40),
    base: BASE,
    issueText: "# Rebuild the board\n\nIt reloads.\n",
    vision: "",
    visionCommit: BASE,
    criteria: [{ criterion: "The board is an app.", basis: "" }],
    prText: "# Board app\n",
    facts: green,
    call: "merge",
    reason: "Loading messages follow from the app.",
    reasonFrom: "the owner",
    date: "2026-11-12",
    notes: "",
  };
  const prompt = landingPrompt(inputs({ precedents: [precedent], sendBacks: [{ head: "3".repeat(40), needsToChange: ["Count stdin in the total."] }] }));
  assert.match(prompt, /does this PR solve the problem the issue describes, meet the criteria entail set for it, and leave the product better\?/u);
  assert.match(prompt, /\*\*needed\*\*: it follows from solving the problem or meeting a criterion/u);
  assert.match(prompt, /never send back a PR for what is needed or harmless/u);
  assert.match(prompt, /1\. Words read from standard input count the same as words in a file\.\n {3}\(Basis: reading: one total\)\n2\. No new flag is added\./u);
  assert.match(prompt, /CI: green\.\n\n- `test`: passed\n\nRequired before merging: `test`\./u);
  assert.match(prompt, /- src\/count\.ts \(modified, \+10 -2\)/u);
  assert.match(prompt, /The PR's description is its author's account and proves nothing/u);
  assert.match(prompt, /<pr>\n# Read standard input/u);
  assert.match(prompt, /<diff>\ndiff --git a\/src\/count\.ts/u);
  assert.match(prompt, /### Case acme-tally-pr-9: the owner's call was merge/u);
  assert.match(prompt, /entail sent this PR back 1 time before:\n\nAt 3{40}:\n- Count stdin in the total\./u);
  assert.match(prompt, /You are in a read-only checkout of acme\/tally at 4{40}, the PR's head/u);

  const long = landingPrompt(inputs({ diff: "x".repeat(200_000) }));
  assert.match(long, /\[…the diff is cut here; read the rest in the checkout\]/u);
});

test("the judgment is one run of its own kind at the PR's head, parsed and routed", async () => {
  const runner = new ScriptedRunner().script(LANDING_KIND, "acme/tally#4", { output: answer(), facts: { estimatedCostUsd: 0.1 } });
  const judgment = await judgeLanding(runner, inputs(), { model: "claude-opus-5-5", effort: "low" });
  assert.ok(judgment.ok);
  assert.equal(judgment.call.call, "merge");
  const [request] = runner.requests;
  assert.equal(request!.kind, LANDING_KIND);
  assert.equal(request!.sha, HEAD);
  assert.equal(request!.checkout, `/checkouts/${HEAD}`);
  assert.equal(request!.effort, "low");
  assert.match(formatLandingCall(judgment.call), /^merge: It solves the problem/u);

  const failing = new ScriptedRunner().script(LANDING_KIND, "acme/tally#4", { output: answer({ call: "ask" }) });
  const failed = await judgeLanding(failing, inputs());
  assert.ok(!failed.ok);
  assert.equal(failed.failure.kind, "no-structured-output");
});
