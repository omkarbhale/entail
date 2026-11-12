import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_CASE_BOOK, readCaseBook } from "../src/case-book.ts";
import { commentRuleViolations, markedTickets } from "../src/comment-rules.ts";
import { answerCall, confirmCall, latestCallOn, overrideCall, unenroll, waitingItems } from "../src/owner.ts";
import { readLog, type CallEntry } from "../src/records.ts";
import { contentHash, isMention } from "../src/watch.ts";
import { ENROLLED_AT, harness, OWNER, REPO, verdict } from "./watch-fixture.ts";

const calls = (dataDirectory: string): CallEntry[] => readLog(dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call");

test("an issue filed after enrollment gets its call posted within one pass, and only once", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes", "Footnotes are skipped today.");
  h.script(
    12,
    verdict({
      rests_on: { vision_lines: ["tally counts words offline."], cases: [] },
      criteria: [{ source: "reading", criterion: "Footnote words count toward the total, not a separate figure.", basis: "Two readings; the total is what users see." }],
    }),
  );

  const first = await h.pass();
  assert.deepEqual(first, { repos: 1, judged: 1, posted: 1, failed: [] });
  assert.equal(h.forge.posted.length, 1);
  const { body } = h.forge.posted[0]!;
  assert.deepEqual(commentRuleViolations(body, OWNER, calls(h.dataDirectory)[0]!.id), []);
  assert.match(body, /^Speaking from Omkar's entail:\n\n\*\*Go\.\*\* Counting words/u);
  assert.doesNotMatch(body, /> tally counts words offline\./u, "a go carries the call, the reason and the criteria");
  assert.match(body, /- Footnote words count toward the total/u);
  assert.match(body, /waits for Omkar to confirm it on entail's board; nothing starts until then/u);
  assert.deepEqual(h.forge.closed, []);

  // entail's own comment comes back as a change; nothing is judged or posted for it.
  const second = await h.pass();
  assert.deepEqual(second, { repos: 1, judged: 0, posted: 0, failed: [] });
  assert.equal(h.forge.posted.length, 1);

  const [call] = calls(h.dataDirectory);
  assert.equal(call!.trigger, "new");
  assert.equal(call!.model, "claude-opus-5-5");
  assert.equal(call!.effort, "low");
  assert.equal(call!.costUsd, 0.05);
  assert.match(call!.issueText, /# Count words in footnotes/u);
  assert.deepEqual(call!.vision, { text: "# Vision\n\ntally counts words offline.\nNew features are opt-in.\n", commit: "a".repeat(40) });
});

test("an edit is judged again, a comment is not, and a no in confirm mode waits to close", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();

  h.forge.comment(12, "Thanks, looking forward to it.");
  assert.equal((await h.pass()).judged, 0);

  h.forge.edit(12, { body: "Also upload the counts to our server." });
  h.script(12, verdict({ call: "no", reason: "Uploading counts goes against tally working offline.", rests_on: { vision_lines: ["tally counts words offline."], cases: [] } }));
  const report = await h.pass();
  assert.equal(report.judged, 1);
  const [, edited] = calls(h.dataDirectory);
  assert.equal(edited!.trigger, "edit");
  assert.equal(h.forge.posted.length, 2);
  assert.match(h.forge.posted[1]!.body, /\*\*No\.\*\* Uploading counts goes against tally working offline\.\n\nIt rests on the vision:\n\n> tally counts words offline\./u);
  assert.match(h.forge.posted[1]!.body, /The issue closes once Omkar confirms this call on entail's board\./u);
  assert.deepEqual(h.forge.closed, []);

  // Only the latest call waits on the owner; the first one was judged again.
  assert.deepEqual(
    waitingItems(h.dataDirectory, []).map((item) => [item.issue.number, item.call]),
    [[12, "no"]],
  );
});

test("with confirm mode off a no closes the issue with its reason in the same comment", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "tally is a command-line counter; a desktop app is another product." }));
  await h.pass();
  assert.equal(h.forge.posted.length, 1);
  assert.match(h.forge.posted[0]!.body, /\*\*No\.\*\* tally is a command-line counter.*\n\nClosing the issue as not planned\./su);
  assert.deepEqual(h.forge.closed, [14]);
  assert.deepEqual(waitingItems(h.dataDirectory, []), []);
});

test("an ask posts only a note that a question waits on the board; the question stays in the records", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Word counts are sometimes wrong");
  h.script(
    11,
    verdict({
      call: "ask",
      reason: "Two readings give users different counts.",
      question: { question: "Does a non-breaking space separate words?", why: "Counts on such text go up under one reading." },
    }),
  );
  await h.pass();
  const { body } = h.forge.posted[0]!;
  assert.match(body, /A question about this issue is waiting for Omkar on entail's board\./u);
  assert.doesNotMatch(body, /non-breaking/u);
  const [item] = waitingItems(h.dataDirectory, []);
  assert.equal(item!.question!.question, "Does a non-breaking space separate words?");
  assert.equal(item!.posted!.closed, false);
});

test("an issue filed before enrollment is judged only when mentioned with /entail, once per mention", async (t) => {
  const h = harness(t);
  h.forge.file(3, "An old request", "", { createdAt: "2026-11-01T00:00:00Z" });
  assert.equal((await h.pass()).judged, 0);

  h.forge.edit(3, { body: "Edited after enrollment, but filed before it." });
  assert.equal((await h.pass()).judged, 0);

  const mention = h.forge.comment(3, "/entail please take a look");
  h.script(3, verdict());
  assert.equal((await h.pass()).judged, 1);
  const [call] = calls(h.dataDirectory);
  assert.equal(call!.trigger, "mention");
  assert.deepEqual(call!.mentions.map((m) => m.id), [mention.id]);
  assert.match(call!.issueText, /\/entail please take a look/u);

  assert.equal((await h.pass()).judged, 0);
});

test("a restart after posting but before recording it finds the comment and never posts twice", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  const close = h.forge.closeIssue.bind(h.forge);
  h.forge.closeIssue = async () => {
    throw new Error("the connection dropped");
  };
  const failed = await h.pass();
  assert.deepEqual(failed.failed, [REPO]);
  assert.match(h.printed.join("\n"), /acme\/tally#14: entail could not act on the issue: the connection dropped; it tries again next pass/u);
  assert.equal(h.forge.posted.length, 1);
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "acted").length, 0);

  h.forge.closeIssue = close;
  const again = await h.pass();
  assert.deepEqual(again, { repos: 1, judged: 0, posted: 1, failed: [] });
  assert.equal(h.forge.posted.length, 1, "the comment already posted is found by its marker");
  assert.deepEqual(h.forge.closed, [14]);
  const acted = readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "acted");
  assert.equal(acted.length, 1);
  assert.deepEqual(markedTickets(h.forge.posted[0]!.body), [calls(h.dataDirectory)[0]!.id]);
});

test("a post that fails does not hold up the posts after it", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.forge.file(13, "Count words in captions");
  h.script(12, verdict());
  h.script(13, verdict());
  const post = h.forge.postComment.bind(h.forge);
  h.forge.postComment = async (target, number, body) => {
    if (number === 12) throw new Error("Not Found");
    return post(target, number, body);
  };
  const report = await h.pass();
  assert.deepEqual(report, { repos: 1, judged: 2, posted: 1, failed: [REPO] });
  assert.deepEqual(h.forge.posted.map((post) => post.issue), [13]);
});

test("a judgment that gives no call is tried again on the next pass", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, "fail", verdict());
  const first = await h.pass();
  assert.deepEqual(first, { repos: 1, judged: 0, posted: 0, failed: [REPO] });
  assert.match(h.printed.join("\n"), /gave no call \(error\): the run broke; it is tried again next pass/u);
  const second = await h.pass();
  assert.deepEqual(second, { repos: 1, judged: 1, posted: 1, failed: [] });
});

test("a forge that fails stops that repo's pass, and the next pass picks up where it was", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.forge.down = true;
  assert.deepEqual((await h.pass()).failed, [REPO]);
  h.forge.down = false;
  h.script(12, verdict());
  assert.deepEqual(await h.pass(), { repos: 1, judged: 1, posted: 1, failed: [] });
});

test("a dry run prints what it would post and changes nothing", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  const report = await h.pass({ dryRun: true });
  assert.deepEqual(report, { repos: 1, judged: 1, posted: 1, failed: [] });
  const printed = h.printed.join("\n");
  assert.match(printed, /acme\/tally#14 \(new\): Make tally a desktop app\n {4}no: Another product\./u);
  assert.match(printed, /would post on acme\/tally#14 and close it:\n {4}Speaking from Omkar's entail:\n\n {4}\*\*No\.\*\* Another product\./u);
  assert.deepEqual(h.forge.posted, []);
  assert.deepEqual(h.forge.closed, []);
  assert.deepEqual(readLog(h.dataDirectory, REPO).map((entry) => entry.type), ["enrolled"]);
  assert.equal(h.options().cursors.get("github:github.com:77"), null);
});

test("a confirmed no closes the issue, and the owner's call lands in the case book", async (t) => {
  const h = harness(t);
  h.forge.file(14, "Make tally a desktop app", "With plugins.");
  h.script(14, verdict({ call: "no", reason: "Another product.", rests_on: { vision_lines: ["tally counts words offline."], cases: [] } }));
  await h.pass();
  const id = latestCallOn(h.dataDirectory, REPO, 14);
  await confirmCall(h.dataDirectory, id, OWNER, new Date("2026-11-12T12:00:00Z"));
  await h.pass();
  assert.equal(h.forge.posted.length, 2);
  assert.match(h.forge.posted[1]!.body, /Omkar confirmed this call on the board: no\. Closing the issue as not planned\./u);
  assert.deepEqual(h.forge.closed, [14]);

  const [past] = await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.slug, "acme--tally-14");
  assert.equal(past!.call, "no");
  assert.equal(past!.reason, "Another product.");
  assert.equal(past!.reasonFrom, "entail's reason, confirmed by Omkar on the board");
  assert.equal(past!.date, "2026-11-12");
  assert.equal(past!.visionCommit, "a".repeat(40));
  assert.match(past!.issueText, /# Make tally a desktop app\n\nWith plugins\./u);
  assert.match(past!.vision, /tally counts words offline/u);
});

test("an override to no replaces the call on the issue, closes it, and is written to the case book", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();
  const id = latestCallOn(h.dataDirectory, REPO, 12);
  await overrideCall(h.dataDirectory, id, OWNER, "no", "Footnotes are not prose.\n\nCounting them misleads writers.");
  await h.pass();
  assert.match(h.forge.posted[1]!.body, /\*\*No\*\*, by Omkar, overriding entail's call on the board\.\n\nFootnotes are not prose\.\n\nCounting them misleads writers\.\n\nClosing the issue as not planned\./u);
  assert.deepEqual(h.forge.closed, [12]);
  const [past] = await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "no");
  assert.equal(past!.reason, "Footnotes are not prose.");
  assert.match(past!.notes, /> Footnotes are not prose\.\n>\n> Counting them misleads writers\./u);
  assert.match(past!.notes, /entail called go: Counting words/u);
});

test("a go answer runs the judgment again with the owner's word, and posts the owner's go with its criteria", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Word counts are sometimes wrong");
  h.script(
    11,
    verdict({ call: "ask", reason: "Two readings.", question: { question: "Does a non-breaking space separate words?", why: "Counts differ." } }),
    verdict({ reason: "The owner chose: a non-breaking space separates words.", criteria: [{ source: "answer", criterion: "A non-breaking space separates words.", basis: "The owner's answer." }] }),
  );
  await h.pass();
  const id = latestCallOn(h.dataDirectory, REPO, 11);
  await answerCall(h.dataDirectory, id, OWNER, "go", "Yes: any whitespace a reader sees separates words.");
  const report = await h.pass();
  assert.equal(report.judged, 1);
  const prompt = h.runner.requests[1]!.prompt;
  assert.match(prompt, /\*\*Omkar \(the owner, on entail's board\)\*\*/u);
  assert.match(prompt, /entail asked the owner: Does a non-breaking space separate words\?\n\nThe owner's answer: go\.\n\nYes: any whitespace/u);

  const body = h.forge.posted[1]!.body;
  assert.match(body, /\*\*Go\*\*, on Omkar's answer on the board\.\n\nThe owner chose/u);
  assert.match(body, /- A non-breaking space separates words\./u);
  assert.deepEqual(h.forge.closed, []);
  assert.deepEqual(h.forge.reopened, [], "an open issue is left as it is");
  const rerun = calls(h.dataDirectory)[1]!;
  assert.equal(rerun.trigger, "owner");
  assert.equal(rerun.owner!.kind, "answer");
  assert.deepEqual(waitingItems(h.dataDirectory, []), []);

  const [past] = await readCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "go");
  assert.equal(past!.reason, "Yes: any whitespace a reader sees separates words.");
  assert.match(past!.notes, /## entail's question\n\n> Does a non-breaking space separate words\?/u);

  // Nothing is left to do: the next pass runs nothing again.
  assert.deepEqual(await h.pass(), { repos: 1, judged: 0, posted: 0, failed: [] });
});

test("a no answer closes the issue with the owner's words, without running the judgment again", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Rewrite tally in Rust");
  h.script(11, verdict({ call: "ask", reason: "Large.", large: true, large_because: "Cannot be undone by one revert.", question: { question: "Go ahead?", why: "Large." } }));
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "Not now; the JavaScript build is fine.");
  await h.pass();
  assert.equal(h.runner.requests.length, 1);
  assert.match(h.forge.posted[1]!.body, /\*\*No\*\*, on Omkar's answer on the board\.\n\nNot now; the JavaScript build is fine\.\n\nClosing the issue/u);
  assert.deepEqual(h.forge.closed, [11]);
});

test("an override to go stands even when the judgment run again on it disagrees", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Add a --json flag");
  h.script(14, verdict({ call: "no", reason: "Nobody asked for it." }), verdict({ call: "no", reason: "Still no." }));
  await h.pass();
  assert.deepEqual(h.forge.closed, [14]);
  await overrideCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 14), OWNER, "go", "Scripts need it.");
  await h.pass();
  const body = h.forge.posted[1]!.body;
  assert.match(body, /\*\*Go\*\*, by Omkar, overriding entail's call on the board\.\n\nScripts need it\.\n\n<!-- entail ticket/u);
  assert.deepEqual(h.forge.reopened, [14], "the issue entail closed is open again");
});

test("model text that would start a line with a slash is escaped, so the comment rules hold", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict({ reason: "Fine.\n/close this", criteria: [{ source: "edge", criterion: "/label nothing", basis: "x" }] }));
  await h.pass();
  const { body } = h.forge.posted[0]!;
  assert.match(body, /\n\\\/close this/u);
  assert.deepEqual(commentRuleViolations(body, OWNER, calls(h.dataDirectory)[0]!.id), []);
});

test("an unenrolled repo is not polled", async (t) => {
  const h = harness(t);
  unenroll(h.dataDirectory, REPO, OWNER);
  h.forge.file(12, "Count words in footnotes");
  assert.deepEqual(await h.pass(), { repos: 0, judged: 0, posted: 0, failed: [] });
});

test("the repo's model and effort settings are the ones the judgment runs with", async (t) => {
  const h = harness(t, { settings: { model: "claude-sonnet-5-5", effort: "medium" } });
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();
  assert.equal(h.runner.requests[0]!.model, "claude-sonnet-5-5");
  assert.equal(h.runner.requests[0]!.effort, "medium");
});

test("a mention is a line starting with /entail, and an edit is a change of title or body", () => {
  assert.ok(isMention("/entail"));
  assert.ok(isMention("Thanks.\n  /entail look again"));
  assert.ok(!isMention("see /entail docs"));
  assert.ok(!isMention("/entailment"));
  assert.equal(contentHash({ title: "A", body: "B " }), contentHash({ title: " A", body: "B" }));
  assert.notEqual(contentHash({ title: "A", body: "B" }), contentHash({ title: "A", body: "C" }));
  assert.ok(ENROLLED_AT < "2026-11-12T10:00:00Z");
});
