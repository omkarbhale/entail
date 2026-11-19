import assert from "node:assert/strict";
import { test } from "node:test";
import { issueParts, pickParts } from "../src/parts.ts";
import { answerCall, callView, formatLog, formatWaiting, latestCallOn, logItems, OwnerError, waitingItems } from "../src/owner.ts";
import { readLog, type ActedEntry, type AnsweredEntry } from "../src/records.ts";
import { harness, OWNER, REPO, verdict } from "./watch-fixture.ts";

/** An answer that takes only some of the parts of an issue that lists several suggestions. */

const BODY = ["Some ideas for tally:", "", "- Count words in footnotes", "  Footnotes are skipped today.", "- Count words in endnotes", "- [ ] Upload the counts to a server", "", "Thanks!"].join("\n");
const question = { question: "Which of these do you want?", why: "They differ in size." };

test("the parts of an issue are the items of its lists, and fewer than two is no bundle", () => {
  const parts = issueParts(BODY);
  assert.deepEqual(parts, [
    { title: "Count words in footnotes", body: "Footnotes are skipped today." },
    { title: "Count words in endnotes", body: "" },
    { title: "Upload the counts to a server", body: "" },
  ]);
  assert.deepEqual(issueParts("1. Only one\n\nSome text."), []);
  assert.deepEqual(issueParts("No list at all."), []);
  assert.deepEqual(issueParts("- a\n  - nested\n- b").map((part) => part.title), ["a", "b"], "a nested item belongs to its part");
  assert.deepEqual(issueParts("```\n- not\n- parts\n```\n- one\n- two").map((part) => part.title), ["one", "two"], "a list in a code fence is not a list of parts");
});

test("picking parts keeps the issue's order, names the rest as turned down, and refuses a bad pick", () => {
  const parts = issueParts(BODY);
  const picked = pickParts(parts, [2, 0]);
  assert.deepEqual(picked.accepted.map((part) => part.title), ["Count words in footnotes", "Upload the counts to a server"]);
  assert.deepEqual(picked.declined, ["Count words in endnotes"]);
  assert.throws(() => pickParts(parts, []), /at least one/u);
  assert.throws(() => pickParts(parts, [3]), /position from 0 to 2/u);
  assert.throws(() => pickParts(parts, [1, 1]), /twice/u);
  assert.throws(() => pickParts(parts, ["1"]), /position/u);
  assert.throws(() => pickParts([], [0]), /no parts/u);
});

test("a partial answer goes through the answer path, under the owner's name; a whole answer is unchanged", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Ideas for tally", BODY);
  h.forge.file(12, "Count words in footnotes");
  h.script(11, verdict({ call: "ask", reason: "Several suggestions.", question }));
  h.script(12, verdict({ call: "ask", reason: "Unsure.", question }));
  await h.pass();
  const id = latestCallOn(h.dataDirectory, REPO, 11);

  const views = waitingItems(h.dataDirectory, [], REPO);
  assert.deepEqual(views.find((view) => view.id === id)!.parts, ["Count words in footnotes", "Count words in endnotes", "Upload the counts to a server"]);
  assert.deepEqual(views.find((view) => view.issue!.number === 12)!.parts, []);
  assert.match(formatWaiting(views), /--accept 1,3[\s\S]*1\. Count words in footnotes\n\s+2\. Count words in endnotes/u);

  await assert.rejects(answerCall(h.dataDirectory, id, OWNER, "go", "x", new Date(), { accept: [0] }), /the call is no/u);
  await assert.rejects(answerCall(h.dataDirectory, id, OWNER, "no", "x", new Date(), { accept: [] }), (error) => error instanceof OwnerError && error.status === 400);
  await assert.rejects(answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 12), OWNER, "no", "x", new Date(), { accept: [0] }), /no parts/u);
  assert.equal(readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "answered").length, 0, "a refused answer records nothing");

  const answered = await answerCall(h.dataDirectory, id, OWNER, "no", "The first and the last.", new Date(), { accept: [0, 2] });
  assert.equal(answered.by, OWNER);
  assert.equal(answered.to, "no");
  assert.deepEqual(answered.parts?.declined, ["Count words in endnotes"]);
  assert.deepEqual(readLog(h.dataDirectory, REPO).filter((entry): entry is AnsweredEntry => entry.type === "answered"), [answered]);

  const whole = await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 12), OWNER, "no", "No.");
  assert.equal(whole.parts, undefined);
  assert.match(formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false }), /ANSWERED by Omkar: took 2 of 3 parts[\s\S]*accepted: Count words in footnotes[\s\S]*turned down: Count words in endnotes/u);
});



test("entail files one issue for each part taken, closes the original naming the parts turned down, and the new issues are judged like any other", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Ideas for tally", BODY);
  h.script(11, verdict({ call: "ask", reason: "Several suggestions.", question }));
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "The first and the last.", new Date(), { accept: [0, 2] });
  h.script(12, verdict({ reason: "Better." }));
  h.script(13, verdict({ call: "no", reason: "Uploading goes against the vision." }));
  await h.pass();

  assert.deepEqual(h.forge.createdIssues.map((issue) => [issue.number, issue.title, issue.labels]), [
    [12, "Count words in footnotes", []],
    [13, "Upload the counts to a server", []],
  ]);
  assert.match(h.forge.createdIssues[0]!.body, /Filed by entail from #11[\s\S]*Footnotes are skipped today\.[\s\S]*<!-- entail part \d+\.0 -->$/u);
  const comment = h.forge.posted.find((post) => post.issue === 11 && /Some of it/u.test(post.body))!;
  assert.match(comment.body, /took 2 of the 3 parts/u);
  assert.match(comment.body, /- #12 Count words in footnotes\n- #13 Upload the counts to a server/u);
  assert.match(comment.body, /Turned down:\n\n- Count words in endnotes/u);
  assert.match(comment.body, /The first and the last\./u);
  assert.ok(h.forge.closed.includes(11));
  assert.deepEqual(h.forge.labelsOn(11), ["entail:no"]);
  const acted = readLog(h.dataDirectory, REPO).filter((entry): entry is ActedEntry => entry.type === "acted" && entry.issue === 11).at(-1)!;
  assert.deepEqual(acted.filed?.map((one) => [one.index, one.number, one.already]), [[0, 12, false], [1, 13, false]]);

  // Nothing is filed twice by a later pass.
  await h.pass();
  assert.equal(h.forge.createdIssues.length, 2);

  // Ordinary intake: the filed issues are judged by the next pass that reads them, with their own calls.
  const calls = readLog(h.dataDirectory, REPO).filter((entry) => entry.type === "call");
  assert.deepEqual(calls.map((entry) => entry.issue.number).sort(), [11, 12, 13]);
});

test("a filing that failed halfway is finished by the next pass without filing the same part twice", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Ideas for tally", BODY);
  h.script(11, verdict({ call: "ask", reason: "Several suggestions.", question }));
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "Two of them.", new Date(), { accept: [0, 1] });
  const create = h.forge.createIssue.bind(h.forge);
  let made = 0;
  h.forge.createIssue = async (title, body, labels) => {
    if (made++ === 1) throw new Error("the forge dropped the connection");
    return create(title, body, labels);
  };
  h.script(12, verdict());
  h.script(13, verdict());
  await h.pass();
  assert.equal(h.forge.createdIssues.length, 1);
  assert.equal(h.forge.closed.includes(11), false, "the original stays open until every part is filed");
  assert.equal(h.forge.posted.some((post) => /Some of it/u.test(post.body)), false);

  await h.pass();
  assert.deepEqual(h.forge.createdIssues.map((issue) => issue.title), ["Count words in footnotes", "Count words in endnotes"]);
  assert.match(h.forge.posted.find((post) => /Some of it/u.test(post.body))!.body, /- #12 Count words in footnotes\n- #13 Count words in endnotes/u);
  assert.ok(h.forge.closed.includes(11));
});

test("a dry run says what it would file and files nothing", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Ideas for tally", BODY);
  h.script(11, verdict({ call: "ask", reason: "Several suggestions.", question }));
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "One.", new Date(), { accept: [1] });
  await h.pass({ dryRun: true });
  assert.equal(h.forge.createdIssues.length, 0);
  assert.match(h.printed.join("\n"), /would file 1 issue from acme\/tally#11[\s\S]*- Count words in endnotes/u);
  assert.equal(callView(REPO, readLog(h.dataDirectory, REPO).find((entry) => entry.type === "call")! as never, { status: "answered" } as never, [], []).parts.length, 3);
});

test("a part whose title is longer than the forge allows is filed under a cut title, with the whole text in the body", async (t) => {
  const h = harness(t);
  const long = `Count words in footnotes ${"and so on ".repeat(40)}`.trim();
  h.forge.file(11, "Ideas for tally", ["Some ideas:", "", `- ${long}`, "- Count words in endnotes"].join("\n"));
  h.script(11, verdict({ call: "ask", reason: "Several suggestions.", question }));
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "The first.", new Date(), { accept: [0] });
  h.script(12, verdict());
  await h.pass();

  const filed = h.forge.createdIssues[0]!;
  assert.equal(filed.title.length, 256);
  assert.equal(filed.title, long.slice(0, 256));
  assert.ok(filed.body.includes(long));
  assert.ok(h.forge.closed.includes(11));
});
