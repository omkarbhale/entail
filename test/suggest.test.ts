import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Case } from "../src/case-book.ts";
import { EventBus } from "../src/events.ts";
import type { Issue } from "../src/forge/forge.ts";
import { formatLog, logItems, logPage, repoViews } from "../src/owner.ts";
import { logFile, readLog, type SuggestedEntry } from "../src/records.ts";
import { checkAgainst } from "../src/schema.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import {
  markedSuggestions,
  readAnswer,
  runSuggestions,
  SUGGEST_KIND,
  SUGGEST_PROMPT_VERSION,
  SUGGESTED_LABEL,
  SuggestionRunningError,
  SuggestionRuns,
  suggestionBody,
  suggestionMarker,
  suggestPrompt,
  SUGGESTIONS_SCHEMA,
  type SuggestAnswer,
  type SuggestForge,
  type SuggestInputs,
  type SuggestionOutcome,
} from "../src/suggest.ts";
import { isMention } from "../src/watch.ts";

const REPO = "acme/tally";
const SHA = "a".repeat(40);
const VISION = "# Vision\n\ntally counts words offline.\nNew features are opt-in.\n";

function inputs(overrides: Partial<SuggestInputs> = {}): SuggestInputs {
  return {
    repo: REPO,
    vision: { text: VISION, commit: SHA },
    readme: { path: "README.md", text: "# tally\n\nCounts words.\n" },
    tree: ["README.md", "VISION.md", "src/count.ts"],
    openIssues: [{ number: 4, title: "Count words in footnotes" }],
    precedents: [],
    checkout: "/tmp/checkout",
    sha: SHA,
    ...overrides,
  };
}

const PAST: Case = {
  slug: "acme-tally-2",
  repo: REPO,
  issue: 2,
  issueText: "# Sync counts to the cloud\n\nUpload every count.\n",
  vision: VISION,
  visionCommit: SHA,
  call: "no",
  reason: "tally is offline.",
  reasonFrom: "the owner's own words",
  date: "2026-11-10",
  notes: "",
};

const ANSWER: SuggestAnswer = {
  suggestions: [
    { title: "Count words in PDFs", body: "PDFs are counted as zero words today.\n\nCount the words in a PDF's text.", size: "one PR", vision_lines: ["tally counts words offline."] },
    { title: "A plugin system for formats", body: "Every new format needs a change to the core.\n\nLet formats be added as plugins.", size: "larger than one PR", vision_lines: [] },
  ],
  left_out: [{ item: "Cloud sync", reason: "turned down before: tally is offline" }],
};

test("the answer's schema takes suggestions with a size and the vision lines, and what was left out with why", () => {
  assert.deepEqual(checkAgainst(SUGGESTIONS_SCHEMA, ANSWER), []);
  assert.deepEqual(checkAgainst(SUGGESTIONS_SCHEMA, { suggestions: [], left_out: [] }), [], "no suggestion at all is a fine answer");
  const wrongSize = { ...ANSWER, suggestions: [{ ...ANSWER.suggestions[0]!, size: "huge" }] };
  assert.match(checkAgainst(SUGGESTIONS_SCHEMA, wrongSize).join(), /size is not one of/u);
  assert.match(checkAgainst(SUGGESTIONS_SCHEMA, { suggestions: [] }).join(), /left_out is missing/u);
  const json = SUGGESTIONS_SCHEMA.json as { properties: { suggestions: { items: { required: string[] } } } };
  assert.deepEqual(json.properties.suggestions.items.required, ["title", "body", "size", "vision_lines"]);
});

test("the prompt carries the vision, the README, the tree, the open issues and the owner's past calls, and asks for the intent, not the wording", () => {
  const prompt = suggestPrompt(inputs({ precedents: [PAST] }));
  assert.match(prompt, /<vision>\n# Vision\n\ntally counts words offline\.\nNew features are opt-in\.\n<\/vision>/u);
  assert.match(prompt, /README\.md:\n\n<readme>\n# tally/u);
  assert.match(prompt, /<tree>\nREADME\.md\nVISION\.md\nsrc\/count\.ts\n<\/tree>/u);
  assert.match(prompt, /- #4: Count words in footnotes/u);
  assert.match(prompt, /### Case acme-tally-2: the owner's call was no/u);
  assert.match(prompt, /The owner's reason: tally is offline\./u);
  assert.match(prompt, /Take its intent, not its wording/u);
  assert.match(prompt, /There is no target number/u);
  assert.match(prompt, /larger than one PR/u);
  assert.match(prompt, /Do not suggest editing the vision itself/u);

  const bare = suggestPrompt(inputs({ vision: null, readme: null, openIssues: [], tree: Array.from({ length: 2100 }, (_, i) => `f${i}`) }));
  assert.match(bare, /This repo has no VISION\.md/u);
  assert.match(bare, /The repo has no README\./u);
  assert.match(bare, /No issues are open\./u);
  assert.match(bare, /There are no past calls on this repo yet\./u);
  assert.match(bare, /\[…100 more paths; list them in the checkout\]/u);
});

test("a suggestion with an open issue's title is left out as already filed, and one with no title is no usable answer", () => {
  const read = readAnswer({ ...ANSWER, suggestions: [...ANSWER.suggestions, { title: " count WORDS in footnotes ", body: "x", size: "one PR", vision_lines: [] }] }, [{ number: 4, title: "Count words in footnotes" }]);
  assert.ok(read.ok);
  assert.deepEqual(read.value.suggestions.map((one) => one.title), ["Count words in PDFs", "A plugin system for formats"]);
  assert.deepEqual(read.value.leftOut.at(-1), { item: "count WORDS in footnotes", reason: "already filed as #4" });
  const blank = readAnswer({ ...ANSWER, suggestions: [{ title: " ", body: "x", size: "one PR", vision_lines: [] }] }, []);
  assert.deepEqual(blank, { ok: false, problem: "suggestion 1 has no title" });
});

test("a filed suggestion says whose entail suggested it, never starts a line with a slash, and ends with its run's marker", () => {
  const body = suggestionBody("Omkar", 77, 1, { title: "t", body: "Problem.\n/entail please\n  /close", size: "larger than one PR", visionLines: ["tally counts words offline."] });
  assert.match(body, /^Suggested by Omkar's entail from the vision and the product as they stand, not written by Omkar\./u);
  assert.match(body, /Size: larger than one PR\./u);
  assert.match(body, /Rests on the vision:\n> tally counts words offline\./u);
  assert.ok(body.endsWith("<!-- entail suggestion 77.1 -->"));
  assert.equal(isMention(body), false, "an /entail in the suggestion is not a mention");
  assert.ok(body.split("\n").every((line) => !/^[ \t]*\//u.test(line)));
  assert.deepEqual(markedSuggestions(body), ["77.1"]);
  assert.throws(() => suggestionMarker(0, 0));
});

/** A forge that files issues in memory. */
class FakeForge implements SuggestForge {
  readonly setting = { forge: "github", host: "github.com", path: REPO } as const;
  readonly issues: Issue[] = [];
  readonly created: { title: string; body: string; labels: readonly string[] }[] = [];
  failAfter: number | null = null;

  constructor() {
    this.issues.push(this.#issue(4, "Count words in footnotes", "", []));
  }

  async project() {
    return { forge: "github" as const, host: "github.com", id: 5001, path: REPO, defaultBranch: "main" };
  }

  async openIssues() {
    return this.issues.filter((issue) => issue.state === "open");
  }

  async labelledIssues(label: string) {
    return this.issues.filter((issue) => issue.labels.includes(label));
  }

  async createIssue(title: string, body: string, labels: readonly string[]) {
    if (this.failAfter !== null && this.created.length >= this.failAfter) throw new Error("GitHub is down");
    this.created.push({ title, body, labels });
    const issue = this.#issue(this.issues.length + 10, title, body, [...labels]);
    this.issues.push(issue);
    return issue;
  }

  #issue(number: number, title: string, body: string, labels: string[]): Issue {
    const at = "2026-11-18T10:00:00Z";
    return { id: 9000 + number, number, title, body, state: "open", author: { forge: "github", host: "github.com", id: 1001, username: "omkarbhale" }, labels, createdAt: at, updatedAt: at, url: `https://github.com/${REPO}/issues/${number}` };
  }
}

function setup(t: TestContext) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "entail-suggest-"));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const forge = new FakeForge();
  const runner = new ScriptedRunner();
  let released = 0;
  const run = (overrides: Partial<Parameters<typeof runSuggestions>[0]> = {}) =>
    runSuggestions({
      dataDirectory,
      repo: REPO,
      by: "Omkar",
      forge,
      read: async () => ({ checkout: "/tmp/checkout", sha: SHA, vision: { text: VISION, commit: SHA }, readme: null, tree: ["src/count.ts"], release: async () => void released++ }),
      runner,
      book: async () => [PAST, { ...PAST, slug: "other-1", repo: "acme/other" }],
      model: "claude-sonnet-5-5",
      effort: "max",
      now: () => new Date("2026-11-18T10:00:00Z"),
      ...overrides,
    });
  return { dataDirectory, forge, runner, run, released: () => released };
}

test("a run files each suggestion as an issue labelled entail:suggested, records the run with what was left out, and never files one twice", async (t) => {
  const { dataDirectory, forge, runner, run, released } = setup(t);
  runner.script(SUGGEST_KIND, REPO, { output: ANSWER, facts: { estimatedCostUsd: 1.25 } });
  const outcome = await run();
  assert.ok(outcome.ok);
  const request = runner.requests[0]!;
  assert.equal(request.model, "claude-sonnet-5-5");
  assert.equal(request.effort, "max");
  assert.equal(request.promptVersion, SUGGEST_PROMPT_VERSION);
  assert.match(request.prompt, /- #4: Count words in footnotes/u, "the open issues are read so nothing filed is suggested again");
  assert.match(request.prompt, /Case acme-tally-2/u);
  assert.doesNotMatch(request.prompt, /Case other-1/u, "only this repo's past calls are precedent");
  assert.equal(released(), 1);

  assert.deepEqual(forge.created.map((one) => [one.title, one.labels]), [
    ["Count words in PDFs", [SUGGESTED_LABEL]],
    ["A plugin system for formats", [SUGGESTED_LABEL]],
  ]);
  assert.ok(forge.created[0]!.body.endsWith(`<!-- entail suggestion ${outcome.run.id}.0 -->`));
  assert.match(forge.created[1]!.body, /Size: larger than one PR\./u);

  const log = readLog(dataDirectory, REPO);
  const suggested = log.find((entry): entry is SuggestedEntry => entry.type === "suggested")!;
  assert.equal(suggested.by, "Omkar");
  assert.equal(suggested.costUsd, 1.25);
  assert.deepEqual(suggested.leftOut, [{ item: "Cloud sync", reason: "turned down before: tally is offline" }]);
  assert.deepEqual(
    log.filter((entry) => entry.type === "suggestion-filed").map((entry) => entry.type === "suggestion-filed" && [entry.index, entry.issue.number, entry.already]),
    [
      [0, 11, false],
      [1, 12, false],
    ],
  );

  // A second run that suggests the same work in other words: what is already open is not filed again by its marker,
  // and the run records its own answer.
  runner.script(SUGGEST_KIND, REPO, { output: { suggestions: [], left_out: [{ item: "Count words in PDFs", reason: "already filed as #11" }] } });
  const second = await run();
  assert.ok(second.ok);
  assert.equal(forge.created.length, 2, "nothing new is filed");
  assert.match(runner.requests[1]!.prompt, /- #11: Count words in PDFs/u);
});

test("a run cut off while filing files only the rest after a restart, finding by its marker what went out before it was recorded", async (t) => {
  const { dataDirectory, forge, runner, run } = setup(t);
  forge.failAfter = 1;
  runner.script(SUGGEST_KIND, REPO, { output: ANSWER });
  await assert.rejects(run(), /GitHub is down/u);
  assert.equal(forge.created.length, 1);
  const runId = readLog(dataDirectory, REPO).find((entry) => entry.type === "suggested")!.id;
  assert.equal(repoViews(dataDirectory, { owner: null, model: "m", effort: "high" }, { all: true })[0]!.suggesting?.state, "done");

  // As if entail stopped between filing the first issue and recording it.
  const withoutRecord = readLog(dataDirectory, REPO).filter((entry) => entry.type !== "suggestion-filed");
  writeFileSync(logFile(dataDirectory, REPO), withoutRecord.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  forge.failAfter = null;
  runner.script(SUGGEST_KIND, REPO, { output: { suggestions: [], left_out: [] } });
  const next = await run();
  assert.ok(next.ok);
  assert.deepEqual(forge.created.map((one) => one.title), ["Count words in PDFs", "A plugin system for formats"], "each filed once");
  const filed = readLog(dataDirectory, REPO).filter((entry) => entry.type === "suggestion-filed");
  assert.deepEqual(filed.map((entry) => entry.type === "suggestion-filed" && [entry.for, entry.index, entry.already]), [
    [runId, 0, true],
    [runId, 1, false],
  ]);
});

test("a run that gives no answer is recorded with why and files nothing", async (t) => {
  const { dataDirectory, forge, runner, run } = setup(t);
  runner.script(SUGGEST_KIND, REPO, { failure: { kind: "timeout", message: "the run was ended after 60 minutes" } });
  const outcome = await run();
  assert.equal(outcome.ok, false);
  assert.equal(forge.created.length, 0);
  const failed = readLog(dataDirectory, REPO).at(-1)!;
  assert.equal(failed.type, "suggest-failed");
  assert.match(failed.type === "suggest-failed" ? failed.reason : "", /\(timeout\): the run was ended after 60 minutes/u);
  const view = repoViews(dataDirectory, { owner: null, model: "m", effort: "high" }, { all: true })[0]!.suggesting;
  assert.equal(view?.state, "failed");
});

test("the log shows each run under its day with what it filed and left out, on the board and in the terminal", async (t) => {
  const { dataDirectory, runner, run } = setup(t);
  runner.script(SUGGEST_KIND, REPO, { output: ANSWER });
  await run();
  const page = logPage(dataDirectory, [], {});
  assert.equal(page.rows.length, 0);
  assert.equal(page.suggestions.length, 1);
  const [view] = page.suggestions;
  assert.equal(view!.day, "2026-11-18");
  assert.deepEqual(view!.suggestions.map((one) => one.issue?.number), [11, 12]);
  assert.deepEqual(view!.leftOut, [{ item: "Cloud sync", reason: "turned down before: tally is offline" }]);
  assert.deepEqual(logPage(dataDirectory, [], { filter: "questions" }).suggestions, [], "only the whole log carries the runs");
  assert.deepEqual(logPage(dataDirectory, [], { before: "2026-11-18" }).suggestions, [], "a run is on its own day's page");

  const text = formatLog(logItems(dataDirectory, []), { repoColumn: true });
  assert.match(text, /Omkar asked entail to suggest work: 2 suggestions · claude-sonnet-5-5 at max effort/u);
  assert.match(text, /suggested \(larger than one PR\): A plugin system for formats/u);
  assert.match(text, /left out: Cloud sync: turned down before: tally is offline/u);
  assert.match(text, /filed suggestion 1 of run \d+: https:\/\/github\.com\/acme\/tally\/issues\/11/u);
});

test("one run per repo at a time: a second start is refused while the first runs, and the board hears the start and the end", async () => {
  const bus = new EventBus();
  const heard: unknown[] = [];
  bus.on((event) => heard.push(event));
  const finish = new Map<string, (outcome: SuggestionOutcome) => void>();
  const runs = new SuggestionRuns({
    events: bus,
    now: () => new Date("2026-11-18T10:00:00Z"),
    run: (repo) => new Promise((resolve) => finish.set(repo, resolve)),
  });
  const started = runs.start(REPO, { model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(started, { repo: REPO, since: "2026-11-18T10:00:00.000Z", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(runs.repos, [REPO]);
  assert.throws(() => runs.start(REPO, { model: "claude-opus-5-5", effort: "low" }), SuggestionRunningError);
  runs.start("acme/other", { model: "claude-opus-5-5", effort: "low" });
  await new Promise((resolve) => setImmediate(resolve));
  finish.get("acme/other")!({ ok: false, failed: { id: 1, at: "", type: "suggest-failed", by: "Omkar", model: "m", effort: "low", reason: "no answer" }, facts: null });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.running("acme/other"), null, "the slot is free once the run ends");
  assert.notEqual(runs.running(REPO), null, "the other repo's run goes on");
  assert.deepEqual(heard.slice(0, 2), [
    { type: "suggesting", repo: REPO },
    { type: "suggesting", repo: "acme/other" },
  ]);
  assert.ok(heard.some((event) => JSON.stringify(event) === JSON.stringify({ type: "suggested", repo: "acme/other", ok: false, suggested: 0, filed: 0, reason: "no answer" })));
});

test("a run that stops before it answers, as on a forge error, is recorded as failed with why", async (t) => {
  const { dataDirectory, forge, run } = setup(t);
  forge.openIssues = async () => {
    throw new Error("gh: HTTP 502");
  };
  const outcome = await run();
  assert.equal(outcome.ok, false);
  const failed = readLog(dataDirectory, REPO).at(-1)!;
  assert.equal(failed.type, "suggest-failed");
  assert.equal(failed.type === "suggest-failed" && failed.reason, "the run stopped before it answered: gh: HTTP 502");
});
