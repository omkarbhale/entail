import assert from "node:assert/strict";
import { test } from "node:test";
import { textBlockers } from "../src/blockers.ts";
import { commentRuleViolations } from "../src/comment-rules.ts";
import { blockedViews, formatLog, logItems, logPage } from "../src/owner.ts";
import { heldIssues, readLog, type BlockedEntry, type CallEntry } from "../src/records.ts";
import { harness, REPO, verdict, type Harness } from "./watch-fixture.ts";

/** An issue blocked by an open issue is held: no call, no criteria, no work, one note, until no blocker is open. */

const OLD = { createdAt: "2026-11-01T00:00:00.000Z" };
const calls = (h: Harness): CallEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is CallEntry => entry.type === "call");
const holds = (h: Harness): BlockedEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is BlockedEntry => entry.type === "blocked");
const blockersOf = (hold: BlockedEntry) => hold.blockers.map((ref) => `${ref.path}#${ref.number}`);

test("the text names blockers: blocked by and depends on, lists, other repos, never code or the issue itself", () => {
  const refs = (body: string) => textBlockers({ number: 5, title: "Export counts", body }, REPO).map((ref) => `${ref.path}#${ref.number}`);
  assert.deepEqual(refs("Blocked by #3."), ["acme/tally#3"]);
  assert.deepEqual(refs("This depends on #3, #4 and #7 & acme/core#9"), ["acme/tally#3", "acme/tally#4", "acme/tally#7", "acme/core#9"]);
  assert.deepEqual(refs("BLOCKED BY: #3\nblocked by #3"), ["acme/tally#3"]);
  assert.deepEqual(refs("Related to #3. See #4."), []);
  assert.deepEqual(refs("`blocked by #3`\n```\ndepends on #4\n```"), []);
  assert.deepEqual(refs("blocked by #5"), [], "an issue never blocks itself");
});

test("an issue blocked in its text gets no call: one note naming the blocker, the entail:blocked label, and nothing more each pass", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(5, "Export per-chapter counts", "Blocked by #3: chapters have to be counted first.");

  const first = await h.pass();
  assert.deepEqual(first, { repos: 1, judged: 0, posted: 1, failed: [] });
  assert.equal(calls(h).length, 0, "no judgment ran");
  const [hold] = holds(h);
  assert.deepEqual(blockersOf(hold!), ["acme/tally#3"]);
  assert.equal(hold!.trigger, "new");
  assert.equal(hold!.forgeLinks, true);
  assert.equal(h.forge.posted.length, 1);
  const { body } = h.forge.posted[0]!;
  assert.deepEqual(commentRuleViolations(body, "Omkar", hold!.id), []);
  assert.match(body, /^Speaking from Omkar's entail:\n\nThis issue is blocked by #3, which is still open\. entail is waiting on it/u);
  assert.match(body, /when it is edited \(for example to remove a blocker\), on an `\/entail` comment, or when the blocker closes\./u);
  assert.deepEqual(h.forge.labelsOn(5), ["entail:blocked"]);

  // entail's own note and label come back as changes to #5; the blocker is unchanged, so nothing new is posted.
  const second = await h.pass();
  assert.deepEqual(second, { repos: 1, judged: 0, posted: 0, failed: [] });
  assert.equal(holds(h).length, 1);
  assert.deepEqual([...heldIssues(readLog(h.dataDirectory, REPO)).keys()], [5]);
  assert.deepEqual(blockedViews(REPO, readLog(h.dataDirectory, REPO)).map((view) => [view.issue, view.blockers]), [[5, ["#3"]]]);
});

test("a blocker closing lets the held issue be judged; its call replaces the hold and the label swaps", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(5, "Export per-chapter counts", "Blocked by #3.");
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(5), ["entail:blocked"]);

  h.forge.edit(3, { state: "closed" });
  h.script(5, verdict({ criteria: [{ source: "reading", criterion: "Counts export as CSV.", basis: "The issue asks for an export." }] }));
  const report = await h.pass();
  assert.equal(report.judged, 1);
  const [call] = calls(h);
  assert.equal(call!.issue.number, 5);
  assert.equal(call!.trigger, "new", "the call carries what first made entail weigh the issue");
  assert.match(h.forge.posted.at(-1)!.body, /\*\*Go\.\*\*[\s\S]*- Counts export as CSV\./u);
  assert.deepEqual(h.forge.labelsOn(5), ["entail:go"]);
  assert.deepEqual(heldIssues(readLog(h.dataDirectory, REPO)).size, 0);
  const row = logPage(h.dataDirectory, []).rows[0]!;
  assert.match(row.trail[0]!.text, /^Held: blocked by #3; posted a note on the issue$/u);
});

test("a blocker linked on the forge holds the issue; without the forge's links only the text counts, and the note says so", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(5, "Export per-chapter counts", "No blocker named here.");
  h.forge.block(5, 3);
  await h.pass();
  assert.deepEqual(blockersOf(holds(h)[0]!), ["acme/tally#3"]);
  assert.doesNotMatch(h.forge.posted[0]!.body, /could not be read/u);

  const g = harness(t, { confirm: false });
  g.forge.noBlockingLinks = true;
  g.forge.file(3, "Count words per chapter", "", OLD);
  g.forge.file(5, "Export per-chapter counts", "Depends on #3.");
  await g.pass();
  assert.equal(holds(g)[0]!.forgeLinks, false);
  assert.match(g.forge.posted[0]!.body, /The forge's own blocked-by links could not be read for this repo, so only this issue's text was checked for blockers\./u);
});

test("an edit while still blocked posts nothing and judges nothing; an edit that removes the blocker is judged", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(5, "Export per-chapter counts", "Blocked by #3.");
  await h.pass();

  h.forge.edit(5, { body: "Blocked by #3. Export as CSV please." });
  assert.deepEqual(await h.pass(), { repos: 1, judged: 0, posted: 0, failed: [] });
  assert.equal(h.forge.posted.length, 1);
  assert.equal(holds(h).length, 1);

  h.forge.edit(5, { body: "Export as CSV please." });
  h.script(5, verdict());
  assert.equal((await h.pass()).judged, 1);
  assert.equal(calls(h).length, 1);
  assert.deepEqual(h.forge.labelsOn(5), ["entail:go"]);
});

test("an /entail comment while still blocked answers with a new note; the mention is carried to the call", async (t) => {
  const h = harness(t);
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(5, "Export per-chapter counts", "Blocked by #3.");
  await h.pass();
  const mention = h.forge.comment(5, "/entail please look at this");
  await h.pass();
  assert.equal(holds(h).length, 2);
  assert.equal(h.forge.posted.length, 2);
  assert.equal(calls(h).length, 0);

  // In confirm mode the call waits for the owner and puts no label on, but the hold's label still comes off.
  h.forge.edit(3, { state: "closed" });
  h.script(5, verdict());
  await h.pass();
  const [call] = calls(h);
  assert.equal(call!.trigger, "mention");
  assert.deepEqual(call!.mentions.map((one) => one.id), [mention.id]);
  assert.deepEqual(h.forge.labelsOn(5), []);
});

test("a mixed set: text and forge blockers, here and in another repo, closed ones ignored; a changed set posts a new note", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(4, "Rename chapters", "", OLD);
  h.forge.file(6, "Chapter model", "", OLD);
  h.forge.edit(4, { state: "closed" });
  h.forge.elsewhere.set("acme/core#9", "open");
  h.forge.file(5, "Export per-chapter counts", "Blocked by #3 and #4. Depends on acme/core#9 and #77.");
  h.forge.block(5, 6);
  await h.pass();
  assert.deepEqual(blockersOf(holds(h)[0]!), ["acme/tally#6", "acme/tally#3", "acme/core#9"], "#4 is closed and #77 does not exist");
  assert.match(h.forge.posted[0]!.body, /blocked by #6, #3 and acme\/core#9, which are still open/u);

  h.forge.edit(3, { state: "closed" });
  await h.pass();
  assert.equal(holds(h).length, 2);
  assert.deepEqual(blockersOf(holds(h)[1]!), ["acme/tally#6", "acme/core#9"]);
  assert.match(h.forge.posted[1]!.body, /blocked by #6 and acme\/core#9/u);

  // Quiet passes read the other repo's blocker, which this repo's feed never reports.
  h.forge.edit(6, { state: "closed" });
  await h.pass();
  assert.equal(holds(h).length, 3);
  assert.deepEqual(blockersOf(holds(h)[2]!), ["acme/core#9"]);
  await h.pass(); // entail's own new note on #5 comes back as a change to it
  h.forge.stateReads.length = 0;
  assert.deepEqual(await h.pass(), { repos: 1, judged: 0, posted: 0, failed: [] });
  assert.deepEqual(h.forge.stateReads, ["acme/core#9"]);

  h.forge.elsewhere.set("acme/core#9", "closed");
  h.script(5, verdict());
  assert.equal((await h.pass()).judged, 1);
  assert.deepEqual(h.forge.labelsOn(5), ["entail:go"]);
  const log = formatLog(logItems(h.dataDirectory, []), { repoColumn: false });
  assert.match(log, /#5 {2}HELD: Export per-chapter counts\n {6}blocked by #6, #3 and acme\/core#9, still open; no call until none is/u);
});

test("a held issue closed is no longer held", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(3, "Count words per chapter", "", OLD);
  h.forge.file(5, "Export per-chapter counts", "Blocked by #3.");
  await h.pass();
  h.forge.edit(5, { state: "closed" });
  await h.pass();
  assert.equal(heldIssues(readLog(h.dataDirectory, REPO)).size, 0);
  assert.equal(calls(h).length, 0);
});
