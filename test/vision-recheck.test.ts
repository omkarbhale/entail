import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { markedTickets } from "../src/comment-rules.ts";
import { JUDGMENT_KIND, RECHECK_PROMPT_VERSION, type Verdict } from "../src/judgment.ts";
import { confirmCall, formatLog, logItems, overrideCall, waitingItems } from "../src/owner.ts";
import { readLog, repoState, type CallEntry, type RecheckedEntry, type VisionSeenEntry } from "../src/records.ts";
import type { RepoReader } from "../src/watch.ts";
import { harness, OWNER, REPO, SHA, verdict, VISION, type Harness } from "./watch-fixture.ts";

/** The vision after the owner changed it: one line removed, one added. */
const NEW_VISION = "# Vision\n\ntally counts words offline.\ntally never adds a second output format.\n";
const NEW_SHA = "c".repeat(40);

const calls = (h: Harness): CallEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call");
const rechecks = (h: Harness): RecheckedEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is RecheckedEntry => entry.type === "rechecked");
const seen = (h: Harness): VisionSeenEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is VisionSeenEntry => entry.type === "vision-seen");

/** The reader after VISION.md changed on the default branch. */
const changed: RepoReader = async () => ({ checkout: "/checkout", sha: NEW_SHA, vision: { text: NEW_VISION, commit: NEW_SHA }, pins: [] });

/** Scripts the re-check's answer on an issue: a verdict with the line of the change that moved it. */
function scriptRecheck(h: Harness, issue: number, answer: Verdict, visionChange = ""): void {
  h.runner.script(JUDGMENT_KIND, `${REPO}#${issue}`, { output: { ...answer, vision_change: visionChange }, facts: { estimatedCostUsd: 0.06 } });
}

/** A go on #12, posted and confirmed by the owner, with an open draft PR that closes it. */
async function clearedWithPullRequest(t: TestContext, options: { confirm: boolean }): Promise<Harness> {
  const h = harness(t, { confirm: options.confirm });
  h.forge.file(12, "Write the counts as JSON", "A --json flag that prints the counts as JSON.");
  h.script(12, verdict({ reason: "A JSON output lets scripts read the counts." }));
  await h.pass();
  if (options.confirm) {
    await confirmCall(h.dataDirectory, calls(h)[0]!.id, OWNER);
    await h.pass();
  }
  h.forge.openPull(40, "Add --json", { head: "d".repeat(40), closes: [12], draft: true });
  await h.pass();
  assert.ok(readLog(h.dataDirectory, REPO).some((entry) => entry.type === "followed" && entry.pr.number === 40));
  return h;
}

test("a vision change that leaves the call as it was posts nothing and logs the re-check", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();
  assert.equal(h.forge.posted.length, 1);

  scriptRecheck(h, 12, verdict({ reason: "Footnotes are words; the new line is about output formats." }));
  const report = await h.pass({ reader: changed });

  assert.equal(report.judged, 1);
  assert.equal(h.forge.posted.length, 1, "a call that holds gets no new comment");
  assert.equal(calls(h).length, 1);
  const [recheck] = rechecks(h);
  assert.equal(recheck!.outcome, "held");
  assert.equal(recheck!.call, calls(h)[0]!.id);
  assert.equal(recheck!.judged?.call, "go");
  assert.equal(recheck!.promptVersion, RECHECK_PROMPT_VERSION);
  assert.equal(seen(h).length, 1);
  assert.equal(seen(h)[0]!.commit, NEW_SHA);
  assert.equal(seen(h)[0]!.from, SHA);
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).vision, { entry: seen(h)[0]!.id, commit: NEW_SHA, text: NEW_VISION });

  // The re-check read the earlier call and the lines the change removed and added.
  const prompt = h.runner.requests.at(-1)!.prompt;
  assert.match(prompt, /## The vision changed since this issue was called/u);
  assert.match(prompt, /entail's call on this issue was \*\*go\*\*/u);
  assert.match(prompt, /<removed>\n- New features are opt-in\.\n<\/removed>/u);
  assert.match(prompt, /<added>\n\+ tally never adds a second output format\.\n<\/added>/u);
  assert.match(prompt, /Change the call only when the vision change requires it/u);
  assert.match(formatLog(logItems(h.dataDirectory, []), { repoColumn: false }), /re-checked after the vision change: the call holds \(go\); nothing posted/u);
});

test("the same vision runs no re-check, and a change is re-checked once", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();

  // Nothing is scripted: a re-check would find no answer and fail the pass.
  const same = await h.pass();
  assert.deepEqual(same, { repos: 1, judged: 0, posted: 0, failed: [] });
  assert.equal(h.runner.requests.length, 1);
  assert.deepEqual(seen(h), []);
  assert.deepEqual(rechecks(h), []);

  scriptRecheck(h, 12, verdict());
  await h.pass({ reader: changed });
  const again = await h.pass({ reader: changed });
  assert.deepEqual(again, { repos: 1, judged: 0, posted: 0, failed: [] });
  assert.equal(h.runner.requests.length, 2);
  assert.equal(seen(h).length, 1);
});

test("in confirm mode a go the vision change makes a no waits on the board, old call to new, and the open PR is flagged", async (t) => {
  const h = await clearedWithPullRequest(t, { confirm: true });
  const [go] = calls(h);
  const posted = h.forge.posted.length;

  scriptRecheck(
    h,
    12,
    verdict({ call: "no", reason: "A JSON output is a second output format, which the vision now rules out.", rests_on: { vision_lines: ["tally never adds a second output format."], cases: [] } }),
    "+ tally never adds a second output format.",
  );
  const report = await h.pass({ reader: changed });
  assert.equal(report.judged, 1);

  const changedCall = calls(h).at(-1)!;
  assert.equal(changedCall.trigger, "vision");
  assert.equal(changedCall.call.call, "no");
  assert.equal(changedCall.confirm, true);
  assert.deepEqual(changedCall.vision, { text: NEW_VISION, commit: NEW_SHA });
  assert.equal(changedCall.recheck!.previous, go!.id);
  assert.equal(changedCall.recheck!.previousCall, "go");
  assert.equal(changedCall.recheck!.passage, "tally never adds a second output format.");
  assert.equal(changedCall.recheck!.passageKind, "added");
  assert.deepEqual(changedCall.recheck!.removed, ["New features are opt-in."]);
  assert.deepEqual(changedCall.recheck!.pullRequests.map((pr) => pr.number), [40]);

  // The issue comment: the vision changed, the line that moved it, the new call, and the PR; it is not closed until the owner confirms.
  const [issueComment, prComment] = h.forge.posted.slice(posted);
  assert.equal(issueComment!.issue, 12);
  assert.match(issueComment!.body, /\*\*VISION\.md changed, and the call changes with it: Go → No\.\*\*/u);
  assert.match(issueComment!.body, /The line the change added that moves the call:\n\n> tally never adds a second output format\./u);
  assert.match(issueComment!.body, /\*\*No\.\*\* A JSON output is a second output format/u);
  assert.match(issueComment!.body, /In-flight work relied on the old text: https:\/\/github\.com\/acme\/tally\/pull\/40/u);
  assert.match(issueComment!.body, /The issue closes once Omkar confirms this call on entail's board\./u);
  assert.deepEqual(h.forge.closed, []);
  assert.ok(h.forge.labelsOn(12).includes("entail:go"), "the label follows the call that acted");

  // The PR gets one comment pointing at the ticket.
  assert.equal(prComment!.issue, 40);
  assert.match(prComment!.body, /relied on the old text/u);
  assert.match(prComment!.body, /\*\*go\*\* → \*\*no\*\*/u);
  assert.match(prComment!.body, /https:\/\/github\.com\/acme\/tally\/issues\/12#issuecomment-\d+/u);
  assert.deepEqual(markedTickets(prComment!.body), [changedCall.id]);
  const acted = readLog(h.dataDirectory, REPO).findLast((entry) => entry.type === "acted");
  assert.deepEqual(acted?.type === "acted" ? acted.flagged?.map((flag) => flag.pr) : null, [40]);

  // The board shows it waiting, with the call it replaced and the passage.
  const [item] = waitingItems(h.dataDirectory, []);
  assert.equal(item!.id, changedCall.id);
  assert.equal(item!.call, "no");
  assert.equal(item!.trigger, "vision");
  assert.deepEqual(item!.recheck && { previousCall: item!.recheck.previousCall, passage: item!.recheck.passage, prs: item!.recheck.pullRequests.map((pr) => pr.number) }, {
    previousCall: "go",
    passage: "tally never adds a second output format.",
    prs: [40],
  });

  // Nothing is posted twice on the next pass, and the confirmation closes it.
  await h.pass({ reader: changed });
  assert.equal(h.forge.posted.length, posted + 2);
  await confirmCall(h.dataDirectory, changedCall.id, OWNER);
  await h.pass({ reader: changed });
  assert.deepEqual(h.forge.closed, [12]);
  assert.ok(h.forge.labelsOn(12).includes("entail:no"));
});

test("with confirm mode off a go the vision change makes a no closes the issue at once", async (t) => {
  const h = await clearedWithPullRequest(t, { confirm: false });
  scriptRecheck(h, 12, verdict({ call: "no", reason: "A second output format is now out." }), "tally never adds a second output format.");
  await h.pass({ reader: changed });
  assert.deepEqual(h.forge.closed, [12]);
  assert.ok(h.forge.labelsOn(12).includes("entail:no"));
  assert.equal(h.forge.posted.filter((one) => one.issue === 40).length, 1);
  assert.match(h.printed.join("\n"), /the vision change moves the call: go → no/u);
});

test("a change to the owner's own call waits for the owner even with confirm mode off", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Write the counts as JSON");
  h.script(12, verdict({ call: "no", reason: "Not needed." }));
  await h.pass();
  await overrideCall(h.dataDirectory, calls(h)[0]!.id, OWNER, "go", "Scripts need it.");
  h.script(12, verdict({ reason: "Scripts read the counts." }));
  await h.pass();
  assert.deepEqual(h.forge.reopened, [12]);
  assert.equal(calls(h).at(-1)!.owner?.call, "go");

  scriptRecheck(h, 12, verdict({ call: "no", reason: "A second output format is now out." }), "tally never adds a second output format.");
  await h.pass({ reader: changed });
  const changedCall = calls(h).at(-1)!;
  assert.equal(changedCall.recheck?.previousCall, "go");
  assert.equal(changedCall.confirm, true);
  assert.deepEqual(h.forge.closed.filter((issue) => issue === 12).length, 1, "only the first no closed it; the changed call waits");
  assert.deepEqual(waitingItems(h.dataDirectory, []).map((item) => item.id), [changedCall.id]);
});

test("a closed issue is not re-checked, and a failed re-check is tried again next pass", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Count words in footnotes");
  h.forge.file(13, "Count words in captions");
  h.script(12, verdict());
  h.script(13, verdict());
  await h.pass();
  h.forge.edit(13, { state: "closed" });

  h.runner.script(JUDGMENT_KIND, `${REPO}#12`, { failure: { kind: "error", message: "the run broke" } });
  await h.pass({ reader: changed });
  assert.deepEqual(
    rechecks(h).map((one) => [one.issue, one.outcome]),
    [
      [12, "failed"],
      [13, "closed"],
    ],
  );

  scriptRecheck(h, 12, verdict());
  await h.pass({ reader: changed });
  assert.deepEqual(
    rechecks(h).map((one) => [one.issue, one.outcome]),
    [
      [12, "failed"],
      [13, "closed"],
      [12, "held"],
    ],
  );
  assert.equal(h.runner.requests.length, 4);
});

test("a dry run re-checks but records and posts nothing", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Write the counts as JSON");
  h.script(12, verdict());
  await h.pass();
  const before = readLog(h.dataDirectory, REPO).length;
  scriptRecheck(h, 12, verdict({ call: "no", reason: "A second output format is now out." }), "tally never adds a second output format.");
  await h.pass({ reader: changed, dryRun: true });
  assert.equal(readLog(h.dataDirectory, REPO).length, before);
  assert.equal(h.forge.posted.length, 1);
  assert.match(h.printed.join("\n"), /would post on acme\/tally#12 and close it/u);
  assert.match(h.printed.join("\n"), /VISION\.md changed, and the call changes with it: Go → No/u);
  assert.equal(VISION.includes("New features are opt-in."), true);
});
