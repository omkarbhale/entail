import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_CASE_BOOK, readCaseBook } from "../src/case-book.ts";
import { answerCall, callView, confirmCall, formatLog, latestCallOn, logItems, overrideCall } from "../src/owner.ts";
import { callText, goLabel, PLANNING_LINE } from "../src/posts.ts";
import { callStatuses, goCallOn, linkCriterion, readLog, type CallEntry } from "../src/records.ts";
import type { Handoff } from "../src/starts.ts";
import { harness, OWNER, REPO, verdict } from "./watch-fixture.ts";

/**
 * A go for planning: a ticket too large for one PR is cleared for planning.
 * It is a go with its own heading, label and handoff scope; the owner's
 * workflow writes the plan, files the smaller tickets and closes the issue.
 */

const CRITERION = { source: "edge" as const, criterion: "Each smaller ticket fits one PR.", basis: "The plan is for size." };
const PLAN = { too_large_for_one_pr: true, large_because: "A store, a command and a board page, each its own PR.", criteria: [CRITERION] };

function recorder(): { handoffs: Handoff[]; startWork: (command: string, handoff: Handoff) => Promise<{ exit: number }> } {
  const handoffs: Handoff[] = [];
  return { handoffs, startWork: async (_command, handoff) => (handoffs.push(handoff), { exit: 0 }) };
}

const calls = (dataDirectory: string): CallEntry[] => readLog(dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call");

test("the posted go for planning opens with its own heading, says what the owner's workflow does, then the plan's criteria", () => {
  const text = callText({ call: "go", reason: "Worth doing, in pieces.", restsOn: { visionLines: [], cases: [] }, criteria: [CRITERION], scope: "plan" }, false, OWNER, 12);
  assert.ok(text.startsWith("**Go, for planning.** Worth doing, in pieces."));
  assert.ok(text.includes(PLANNING_LINE));
  assert.match(PLANNING_LINE, /writes the plan and files the smaller tickets/u);
  assert.match(PLANNING_LINE, /entail closes nothing here/u);
  assert.match(text, /What the plan must do beyond solving the issue:\n\n- Each smaller ticket fits one PR\.\n- Link the PR/u);
  assert.equal(goLabel("plan"), "entail:plan");
  assert.equal(goLabel("implement"), "entail:go");

  const implement = callText({ call: "go", reason: "Fine.", restsOn: { visionLines: [], cases: [] }, criteria: [] }, false, OWNER, 12);
  assert.ok(implement.startsWith("**Go.** Fine."), "a go logged before scope was kept posts as a go to implement");
  assert.ok(!implement.includes(PLANNING_LINE));
});

test("with confirm mode off a go for planning is labelled entail:plan, starts work with scope plan, and closes nothing", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-workflow" } });
  const start = recorder();
  h.forge.file(12, "Add team accounts");
  h.script(12, verdict(PLAN));
  await h.pass({ startWork: start.startWork });

  const body = h.forge.posted[0]!.body;
  assert.match(body, /\*\*Go, for planning\.\*\* /u);
  assert.match(body, /What the plan must do beyond solving the issue:/u);
  assert.deepEqual(h.forge.labelsOn(12), ["entail:plan"]);
  assert.deepEqual(h.forge.closed, []);
  assert.equal(start.handoffs.length, 1);
  assert.equal(start.handoffs[0]!.scope, "plan");
  assert.deepEqual(start.handoffs[0]!.criteria, [CRITERION, linkCriterion(12)]);

  // A PR the owner's workflow links to the issue is still judged against its criteria.
  assert.equal(goCallOn(readLog(h.dataDirectory, REPO), 12)?.id, calls(h.dataDirectory)[0]!.id);
});

test("a plain go hands off scope implement and is labelled entail:go", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-workflow" } });
  const start = recorder();
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass({ startWork: start.startWork });
  assert.match(h.forge.posted[0]!.body, /^.*\*\*Go\.\*\* /mu);
  assert.deepEqual(h.forge.labelsOn(12), ["entail:go"]);
  assert.equal(start.handoffs[0]!.scope, "implement");
});

test("in confirm mode a go for planning waits unlabelled; the confirmation says so, labels entail:plan and hands off scope plan", async (t) => {
  const h = harness(t, { settings: { start: "my-workflow" } });
  const start = recorder();
  h.forge.file(12, "Add team accounts");
  h.script(12, verdict(PLAN));
  await h.pass({ startWork: start.startWork });
  assert.deepEqual(h.forge.labelsOn(12), []);
  assert.equal(start.handoffs.length, 0);

  const id = latestCallOn(h.dataDirectory, REPO, 12);
  const entries = readLog(h.dataDirectory, REPO);
  const view = callView(REPO, calls(h.dataDirectory)[0]!, callStatuses(entries).get(id)!, entries, []);
  assert.equal(view.call, "go");
  assert.equal(view.scope, "plan");

  await confirmCall(h.dataDirectory, id, OWNER);
  await h.pass({ startWork: start.startWork });
  assert.match(h.forge.posted[1]!.body, /confirmed this call on the board: go, for planning\./u);
  assert.deepEqual(h.forge.labelsOn(12), ["entail:plan"]);
  assert.equal(start.handoffs[0]!.scope, "plan");
});

test("an override to plan swaps the label to entail:plan and hands off scope plan; the case book says it was for planning", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-workflow" } });
  const start = recorder();
  h.forge.file(14, "Add team accounts");
  h.script(14, verdict({ call: "no", reason: "Too much." }), verdict({ reason: "The owner wants it planned." }));
  await h.pass({ startWork: start.startWork });
  assert.deepEqual(h.forge.labelsOn(14), ["entail:no"]);

  await overrideCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 14), OWNER, "plan", "Plan it into tickets.");
  await h.pass({ startWork: start.startWork });
  assert.match(h.runner.requests[1]!.prompt, /The owner overrode it: go, for planning\./u);
  const body = h.forge.posted[1]!.body;
  assert.match(body, /^.*\*\*Go, for planning\*\*, by Omkar, overriding entail's call on the board\.\n\nPlan it into tickets\.\n\nThe owner's workflow writes the plan/mu);
  assert.deepEqual(h.forge.labelsOn(14), ["entail:plan"]);
  assert.deepEqual(h.forge.labelWrites, ["+entail:no #14", "-entail:no #14", "+entail:plan #14"]);
  assert.deepEqual(h.forge.reopened, [14]);
  assert.equal(start.handoffs.at(-1)!.scope, "plan");
  assert.equal(start.handoffs.at(-1)!.by, "owner");

  const [past] = await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "go");
  assert.match(past!.notes, /## A go for planning/u);
  assert.match(formatLog(logItems(h.dataDirectory, []), { repoColumn: false }), /OVERRIDDEN by Omkar to go, for planning/u);
});

test("an override or answer of go stays a go to implement even when the judgment run again finds the ticket too large", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-workflow" } });
  const start = recorder();
  const question = { question: "Which reading?", why: "They differ." };
  h.forge.file(11, "Word counts are sometimes wrong");
  h.script(11, verdict({ call: "ask", reason: "Two readings.", question }), verdict(PLAN));
  await h.pass({ startWork: start.startWork });
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "go", "The first one.");
  await h.pass({ startWork: start.startWork });
  assert.match(h.forge.posted[1]!.body, /^.*\*\*Go\*\*, on Omkar's answer on the board\./mu);
  assert.deepEqual(h.forge.labelsOn(11), ["entail:go"]);
  assert.equal(start.handoffs[0]!.scope, "implement");
});

test("an answer of plan posts a go for planning on the owner's answer", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-workflow" } });
  const start = recorder();
  const question = { question: "Go ahead?", why: "It replaces the log format." };
  h.forge.file(11, "Move the log to SQLite");
  h.script(11, verdict({ call: "ask", reason: "Hard to undo.", hard_to_undo: true, question }), verdict({ reason: "The owner answered." }));
  await h.pass({ startWork: start.startWork });
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "plan", "Yes, in steps.");
  await h.pass({ startWork: start.startWork });
  assert.match(h.forge.posted[1]!.body, /^.*\*\*Go, for planning\*\*, on Omkar's answer on the board\./mu);
  assert.deepEqual(h.forge.labelsOn(11), ["entail:plan"]);
  assert.equal(start.handoffs[0]!.scope, "plan");
  assert.equal(calls(h.dataDirectory).at(-1)!.owner!.scope, "plan");
});

test("a go for planning can be overridden to a go to implement, but not to plan again", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Add team accounts");
  h.script(12, verdict(PLAN), verdict({ reason: "One PR after all." }));
  await h.pass();
  const id = latestCallOn(h.dataDirectory, REPO, 12);
  await assert.rejects(overrideCall(h.dataDirectory, id, OWNER, "plan", "Plan it."), /already plan/u);
  const action = await overrideCall(h.dataDirectory, id, OWNER, "go", "It fits one PR.");
  assert.equal(action.scope, undefined);
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(12), ["entail:go"]);
});
