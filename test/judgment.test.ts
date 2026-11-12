import assert from "node:assert/strict";
import { test } from "node:test";
import type { Case } from "../src/case-book.ts";
import {
  formatCall,
  judge,
  JUDGMENT_KIND,
  judgmentPrompt,
  routeVerdict,
  VERDICT_SCHEMA,
  type JudgmentInputs,
  type Verdict,
} from "../src/judgment.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import { checkAgainst } from "../src/schema.ts";

const VISION = "# Vision\n\ntally never reaches the network.\nNew features are opt-in.\n";

function precedent(slug: string, call: "go" | "no"): Case {
  return {
    slug,
    repo: "acme/tally",
    issue: 3,
    issueText: `# The ${slug} issue\n\nIts body.\n`,
    vision: VISION,
    visionCommit: "c".repeat(40),
    call,
    reason: `The reason for ${slug}.`,
    reasonFrom: "the owner's comment",
    date: "2026-11-01",
    notes: "## The owner's words\n\n> quoted",
  };
}

function inputs(overrides: Partial<JudgmentInputs> = {}): JudgmentInputs {
  return {
    repo: "acme/tally",
    issueNumber: 12,
    issueText: "# Send usage stats home\n\nCount commands and upload them nightly.\n",
    vision: { text: VISION, commit: "b".repeat(40) },
    pins: ["How totals are rounded"],
    precedents: [precedent("acme--tally-3", "no"), precedent("acme--tally-4", "go")],
    checkout: "/checkout",
    sha: "b".repeat(40),
    ...overrides,
  };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    call: "go",
    reason: "It makes the product better.",
    rests_on: { vision_lines: [], cases: [] },
    large: false,
    large_because: "",
    criteria: [],
    question: null,
    ...overrides,
  };
}

const flag = { source: "vision" as const, criterion: "The stats are behind a flag, off by default.", basis: "> New features are opt-in." };

test("the prompt asks the owner's question and holds the vision in full, the pins, the precedents and the issue", () => {
  const prompt = judgmentPrompt(inputs());
  assert.match(prompt, /would doing what this issue asks make the product better, as the owner would see it\?/u);
  assert.ok(prompt.includes(`VISION.md at ${"b".repeat(40)}`));
  assert.ok(prompt.includes(VISION.trim()), "the whole vision");
  assert.ok(prompt.includes("- How totals are rounded"), "the pins");
  assert.ok(prompt.includes("Case acme--tally-3: the owner's call was no"));
  assert.ok(prompt.includes("The reason for acme--tally-3."));
  assert.ok(prompt.includes("> quoted"), "the owner's words on a past case");
  assert.ok(prompt.includes("# The acme--tally-4 issue"), "a precedent's issue");
  assert.ok(prompt.includes("## The issue: acme/tally#12"));
  assert.ok(prompt.includes("Count commands and upload them nightly."), "the issue");
  assert.ok(prompt.includes(`read-only checkout of acme/tally at ${"b".repeat(40)}`));
});

test("the prompt says so when there is no vision, no pin and no past case", () => {
  const prompt = judgmentPrompt(inputs({ vision: null, pins: [], precedents: [] }));
  assert.match(prompt, /This repo has no VISION\.md\. Judge on the merits alone\./u);
  assert.match(prompt, /pinned no topics/u);
  assert.match(prompt, /no past cases yet/u);
});

test("a long past issue is clipped in the prompt, never the issue being judged", () => {
  const long = `# Long\n\n${"word ".repeat(2000)}`;
  const prompt = judgmentPrompt(inputs({ issueText: long, precedents: [{ ...precedent("p", "go"), issueText: long }] }));
  assert.match(prompt, /the rest of the issue is left out/u);
  assert.ok(prompt.includes(long.trim()));
});

test("go routes to go with its criteria", () => {
  const routed = routeVerdict(verdict({ criteria: [flag], rests_on: { vision_lines: ["New features are opt-in."], cases: [] } }));
  assert.deepEqual(routed, {
    ok: true,
    call: { call: "go", reason: "It makes the product better.", restsOn: { visionLines: ["New features are opt-in."], cases: [] }, criteria: [flag] },
  });
});

test("no routes to no, dropping any criteria or question", () => {
  const routed = routeVerdict(verdict({ call: "no", reason: "Against the vision.", criteria: [flag], question: { question: "q", why: "w" } }));
  assert.deepEqual(routed, { ok: true, call: { call: "no", reason: "Against the vision.", restsOn: { visionLines: [], cases: [] } } });
});

test("ask routes to ask with its one question", () => {
  const routed = routeVerdict(verdict({ call: "ask", question: { question: "Which totals?", why: "Two readings differ." } }));
  assert.deepEqual(routed, {
    ok: true,
    call: { call: "ask", reason: "It makes the product better.", restsOn: { visionLines: [], cases: [] }, question: "Which totals?", why: "Two readings differ.", large: false, criteria: [] },
  });
});

test("a go on a large or hard-to-undo change becomes ask, keeping the criteria a go would carry", () => {
  const withoutQuestion = routeVerdict(verdict({ large: true, large_because: "It changes the stored file format.", criteria: [flag] }));
  assert.ok(withoutQuestion.ok);
  assert.equal(withoutQuestion.call.call, "ask");
  assert.ok(withoutQuestion.call.call === "ask");
  assert.match(withoutQuestion.call.question, /Go ahead/u);
  assert.equal(withoutQuestion.call.why, "It changes the stored file format.");
  assert.equal(withoutQuestion.call.large, true);
  assert.deepEqual(withoutQuestion.call.criteria, [flag]);

  const withQuestion = routeVerdict(verdict({ large: true, large_because: "x", question: { question: "Replace the format?", why: "Old files stop opening." } }));
  assert.ok(withQuestion.ok && withQuestion.call.call === "ask");
  assert.equal(withQuestion.call.question, "Replace the format?");
});

test("a no on a large change stays no: nothing is done, so nothing needs undoing", () => {
  const routed = routeVerdict(verdict({ call: "no", large: true, large_because: "x" }));
  assert.ok(routed.ok);
  assert.equal(routed.call.call, "no");
});

test("an ask with no question is not a usable answer", () => {
  assert.deepEqual(routeVerdict(verdict({ call: "ask" })), { ok: false, problem: "the answer is ask but carries no question" });
  assert.equal(routeVerdict(verdict({ call: "ask", question: { question: " ", why: "w" } })).ok, false);
});

test("the answer's schema accepts every verdict shape and refuses an unknown call or criterion source", () => {
  for (const shape of [verdict(), verdict({ call: "no" }), verdict({ call: "ask", question: { question: "q", why: "w" } }), verdict({ criteria: [flag] })]) {
    assert.deepEqual(checkAgainst(VERDICT_SCHEMA, shape), []);
  }
  assert.notDeepEqual(checkAgainst(VERDICT_SCHEMA, { ...verdict(), call: "maybe" }), []);
  assert.notDeepEqual(checkAgainst(VERDICT_SCHEMA, verdict({ criteria: [{ ...flag, source: "tests" as never }] })), []);
});

test("judge makes one run with the prompt, the model and effort asked for, and routes its answer", async () => {
  const runner = new ScriptedRunner().script(JUDGMENT_KIND, "acme/tally#12", { output: verdict({ call: "no", reason: "Against the vision." }) });
  const judgment = await judge(runner, inputs(), { model: "claude-opus-5-5", effort: "low" });
  assert.ok(judgment.ok);
  assert.equal(judgment.call.call, "no");
  assert.equal(runner.requests.length, 1);
  const [request] = runner.requests;
  assert.equal(request!.prompt, judgmentPrompt(inputs()));
  assert.equal(request!.model, "claude-opus-5-5");
  assert.equal(request!.effort, "low");
  assert.equal(request!.checkout, "/checkout");
});

test("judge reports a machine failure, an off-schema answer and an ask without a question as no call", async () => {
  const runner = new ScriptedRunner().script(
    JUDGMENT_KIND,
    "acme/tally#12",
    { failure: { kind: "timeout", message: "too slow" } },
    { output: { call: "go" } },
    { output: verdict({ call: "ask" }) },
  );
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    const judgment = await judge(runner, inputs());
    assert.equal(judgment.ok, false);
    if (!judgment.ok) kinds.push(judgment.failure.kind);
  }
  assert.deepEqual(kinds, ["timeout", "no-structured-output", "no-structured-output"]);
});

test("a call prints with its reason, what it rests on, and its criteria or question", () => {
  const go = routeVerdict(verdict({ criteria: [flag], rests_on: { vision_lines: ["New features are opt-in."], cases: ["acme--tally-4"] } }));
  assert.ok(go.ok);
  assert.equal(
    formatCall(go.call),
    [
      "go: It makes the product better.",
      "  rests on the vision: > New features are opt-in.",
      "  rests on case acme--tally-4",
      "",
      "Criteria:",
      "  - [vision] The stats are behind a flag, off by default.",
      "      > New features are opt-in.",
    ].join("\n"),
  );
  const ask = routeVerdict(verdict({ call: "ask", question: { question: "Which totals?", why: "Two readings." } }));
  assert.ok(ask.ok);
  assert.match(formatCall(ask.call), /Question: Which totals\?\nWhy it is a question: Two readings\./u);
});
