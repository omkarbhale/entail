import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { confirmCall, formatLog, logItems, overrideCall, waitingItems } from "../src/owner.ts";
import { readLog, type CallEntry, type HandedBackEntry, type PrActedEntry } from "../src/records.ts";
import type { SendBackHandoff } from "../src/send-backs.ts";
import { runStart } from "../src/starts.ts";
import { harness, landingAnswer, OWNER, REPO, verdict, type Harness } from "./watch-fixture.ts";

const EXAMPLE = fileURLToPath(new URL("../examples/send-back-to-file.sh", import.meta.url));
const HEADS = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
const CRITERION = "Words from standard input count toward the same total.";

/** A send-back command that records each handoff instead of running anything. */
function recorder(result: { exit: number | null; error?: string } = { exit: 0 }) {
  const handoffs: { command: string; handoff: SendBackHandoff }[] = [];
  return { handoffs, handBack: async (command: string, handoff: SendBackHandoff) => (handoffs.push({ command, handoff }), result) };
}

const handedBack = (h: Harness) => readLog(h.dataDirectory, REPO).filter((entry): entry is HandedBackEntry => entry.type === "handed-back");
const prActs = (h: Harness) => readLog(h.dataDirectory, REPO).filter((entry): entry is PrActedEntry => entry.type === "pr-acted");
const prPosts = (h: Harness, pr: number) => h.forge.posted.filter((post) => post.issue === pr);

async function goIssue(h: Harness): Promise<void> {
  h.forge.file(1, "Read standard input", "tally only reads files.");
  h.script(1, verdict({ criteria: [{ source: "reading", criterion: CRITERION, basis: "One total is what users see." }] }));
  await h.pass();
}

const sendBack = (what: string) =>
  landingAnswer({
    call: "send-back",
    reason: "Standard input is counted separately.",
    criteria: [{ criterion: CRITERION, met: false, evidence: "src/count.ts prints a second total." }],
    needs_to_change: [what],
  });

test("a send-back hands the PR to the command once, with what needs to change and the checklist, after the comment is posted", async (t) => {
  const h = harness(t, { confirm: false, settings: { sendBack: "my-agent --resume" } });
  const hand = recorder();
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  h.forge.report(HEADS[0]!, ["test", "passed"]);
  h.scriptLanding(4, sendBack("Count standard input in the one total."));

  await h.pass({ handBack: hand.handBack });
  assert.equal(prPosts(h, 4).length, 1, "the comment is posted");
  assert.equal(hand.handoffs.length, 1);
  const landing = readLog(h.dataDirectory, REPO).find((entry) => entry.type === "landing")!;
  const { command, handoff } = hand.handoffs[0]!;
  assert.equal(command, "my-agent --resume");
  assert.deepEqual(handoff, {
    repo: REPO,
    outcome: "send-back",
    pr: { number: 4, url: "https://github.com/acme/tally/pull/4", title: "Read standard input" },
    issue: { number: 1, url: "https://github.com/acme/tally/issues/1", title: "Read standard input" },
    head: HEADS[0],
    call: landing.id,
    by: "entail",
    reason: "Standard input is counted separately.",
    needsToChange: ["Count standard input in the one total."],
    checklist: [{ criterion: CRITERION, met: false, evidence: "src/count.ts prints a second total." }],
    criteria: (landing as Extract<typeof landing, { type: "landing" }>).criteria,
  });
  assert.equal(handedBack(h).length, 1);
  assert.equal(handedBack(h)[0]!.exit, 0);
  assert.equal(handedBack(h)[0]!.pr, 4);

  await h.pass({ handBack: hand.handBack });
  assert.equal(hand.handoffs.length, 1, "once per send-back");
  assert.match(formatLog(logItems(h.dataDirectory, []), { repoColumn: false }), /#4 {2}handed the PR to: my-agent --resume/u);
});

test("a command that fails changes nothing: the comment, the record of the call and the next send-back stand", async (t) => {
  const h = harness(t, { confirm: false, settings: { sendBack: "my-agent" } });
  const hand = recorder({ exit: 1, error: "exited 1: no executor" });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  h.forge.report(HEADS[0]!, ["test", "passed"]);
  h.scriptLanding(4, sendBack("Fix it."));
  await h.pass({ handBack: hand.handBack });
  assert.equal(prPosts(h, 4).length, 1);
  assert.equal(prActs(h)[0]!.sentBack, true);
  assert.equal(handedBack(h)[0]!.exit, 1);
  assert.equal(handedBack(h)[0]!.error, "exited 1: no executor");
  assert.match(formatLog(logItems(h.dataDirectory, []), { repoColumn: false }), /the send-back command failed: my-agent \(exited 1: no executor\)/u);

  h.forge.editPull(4, { headSha: HEADS[1]! });
  h.forge.report(HEADS[1]!, ["test", "passed"]);
  h.scriptLanding(4, sendBack("Fix it again."));
  await h.pass({ handBack: hand.handBack });
  assert.equal(hand.handoffs.length, 2, "a failed command does not stop the next send-back from being handed over");
});

test("with no command set nothing runs and nothing is recorded", async (t) => {
  const h = harness(t, { confirm: false });
  const hand = recorder();
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  h.forge.report(HEADS[0]!, ["test", "passed"]);
  h.scriptLanding(4, sendBack("Fix it."));
  await h.pass({ handBack: hand.handBack });
  assert.equal(hand.handoffs.length, 0);
  assert.equal(prActs(h)[0]!.handoff, undefined);
  assert.deepEqual(handedBack(h), []);
});

test("a merge, a question and a call waiting for the owner do not run the command", async (t) => {
  const h = harness(t, { confirm: false, settings: { sendBack: "my-agent" } });
  const hand = recorder();
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  h.forge.report(HEADS[0]!, ["test", "passed"]);
  h.scriptLanding(4, landingAnswer({ criteria: [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }] }));
  await h.pass({ handBack: hand.handBack });
  assert.deepEqual(h.forge.merges.map((merge) => merge.pr), [4]);
  assert.equal(hand.handoffs.length, 0, "not when a PR merges");

  const c = harness(t, { confirm: true, settings: { sendBack: "my-agent" } });
  await goIssue(c);
  const go = readLog(c.dataDirectory, REPO).findLast((e): e is CallEntry => e.type === "call")!;
  await confirmCall(c.dataDirectory, go.id, OWNER);
  await c.pass({ handBack: hand.handBack });
  c.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  c.forge.report(HEADS[0]!, ["test", "passed"]);
  c.scriptLanding(4, landingAnswer({ criteria: [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }] }));
  await c.pass({ handBack: hand.handBack });
  assert.ok(waitingItems(c.dataDirectory, []).some((item) => item.kind === "pr"), "raised to the board");
  assert.equal(hand.handoffs.length, 0, "not when a PR is raised to the board");
});

test("a cancel hands the PR over as cancelled; with confirm mode on, once the owner confirms the close and not before", async (t) => {
  const cancelled = async (confirm: boolean) => {
    const h = harness(t, { confirm, settings: { sendBack: "my-agent" } });
    const hand = recorder();
    await goIssue(h);
    if (confirm) {
      const go = readLog(h.dataDirectory, REPO).findLast((e): e is CallEntry => e.type === "call")!;
      await confirmCall(h.dataDirectory, go.id, OWNER);
      await h.pass({ handBack: hand.handBack });
    }
    h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
    for (const [index, head] of HEADS.entries()) {
      if (index > 0) h.forge.editPull(4, { headSha: head });
      h.forge.report(head, ["test", "passed"]);
      h.scriptLanding(4, sendBack(`Fix it, round ${index + 1}.`));
      await h.pass({ handBack: hand.handBack });
    }
    return { h, hand };
  };

  const off = await cancelled(false);
  assert.deepEqual(off.h.forge.closedPulls, [4]);
  assert.deepEqual(off.hand.handoffs.map((one) => one.handoff.outcome), ["send-back", "send-back", "send-back", "cancel"]);
  assert.equal(off.hand.handoffs[3]!.handoff.head, HEADS[3]);

  const on = await cancelled(true);
  assert.deepEqual(on.h.forge.closedPulls, [], "the close waits for the owner");
  assert.deepEqual(on.hand.handoffs.map((one) => one.handoff.outcome), ["send-back", "send-back", "send-back"], "the call that waits to close the PR is not handed over yet");
  const [item] = waitingItems(on.h.dataDirectory, []).filter((one) => one.kind === "pr");
  await confirmCall(on.h.dataDirectory, item!.id, OWNER);
  await on.h.pass({ handBack: on.hand.handBack });
  assert.deepEqual(on.h.forge.closedPulls, [4]);
  assert.deepEqual(on.hand.handoffs.map((one) => one.handoff.outcome), ["send-back", "send-back", "send-back", "cancel"]);
  assert.equal(on.hand.handoffs[3]!.handoff.by, "owner");
});

test("the owner's override to send back hands the PR over with their words", async (t) => {
  const h = harness(t, { confirm: true, settings: { sendBack: "my-agent" } });
  const hand = recorder();
  await goIssue(h);
  const go = readLog(h.dataDirectory, REPO).findLast((e): e is CallEntry => e.type === "call")!;
  await confirmCall(h.dataDirectory, go.id, OWNER);
  await h.pass({ handBack: hand.handBack });
  h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  h.forge.report(HEADS[0]!, ["test", "passed"]);
  h.scriptLanding(4, landingAnswer({ criteria: [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }] }));
  await h.pass({ handBack: hand.handBack });
  const [item] = waitingItems(h.dataDirectory, []).filter((one) => one.kind === "pr");
  await overrideCall(h.dataDirectory, item!.id, OWNER, "send-back", "Keep the README example working too.");
  await h.pass({ handBack: hand.handBack });
  assert.equal(hand.handoffs.length, 1);
  assert.equal(hand.handoffs[0]!.handoff.by, "owner");
  assert.deepEqual(hand.handoffs[0]!.handoff.needsToChange, ["Keep the README example working too."]);
  assert.equal(hand.handoffs[0]!.handoff.ownerWords, "Keep the README example working too.");
});

test("a dry run shows the handoff and runs nothing", async (t) => {
  const h = harness(t, { confirm: false, settings: { sendBack: "my-agent" } });
  const hand = recorder();
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEADS[0]!, closes: [1] });
  h.forge.report(HEADS[0]!, ["test", "passed"]);
  h.scriptLanding(4, sendBack("Fix it."));
  await h.pass({ handBack: hand.handBack, dryRun: true });
  assert.equal(hand.handoffs.length, 0);
  assert.deepEqual(handedBack(h), []);
});

test("the example send-back command appends each handoff to a file, one line each", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entail-send-back-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "out.jsonl");
  let command: string;
  if (process.platform === "win32") {
    command = `set "ENTAIL_SEND_BACK_FILE=${file}" && "${EXAMPLE.replace(/\.sh$/u, ".cmd")}"`;
  } else {
    command = join(directory, "run.sh");
    writeFileSync(command, `#!/bin/sh\nENTAIL_SEND_BACK_FILE='${file}' exec '${EXAMPLE}'\n`);
    chmodSync(command, 0o755);
  }
  const handoff = { repo: REPO, outcome: "send-back", pr: { number: 4 } };
  assert.deepEqual(await runStart(command, handoff), { exit: 0 });
  assert.deepEqual(await runStart(command, handoff), { exit: 0 });
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), handoff);
});
