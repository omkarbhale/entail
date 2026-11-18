import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCall, confirmCall, HOLD_MS, latestCallOn, overrideCall, repoViews } from "../src/owner.ts";
import { readLog, type ActedEntry } from "../src/records.ts";
import { harness, OWNER, REPO, verdict } from "./watch-fixture.ts";

/** The `entail:` label each act puts on an issue: the call that acted on it, one at a time. */

const acted = (dataDirectory: string): ActedEntry[] => readLog(dataDirectory, REPO).filter((entry): entry is ActedEntry => entry.type === "acted");
const settings = { owner: OWNER, model: "claude-opus-5-5", effort: "low" as const };
const NOW = new Date("2026-11-12T12:00:00Z");

test("with confirm mode off a go and a no are labelled as they act, and the label is recorded with the act", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Count words in footnotes");
  h.forge.file(14, "Make tally a desktop app");
  h.script(12, verdict());
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(12), ["entail:go"]);
  assert.deepEqual(h.forge.labelsOn(14), ["entail:no"]);
  assert.deepEqual(h.forge.closed, [14]);
  assert.deepEqual(
    acted(h.dataDirectory).map((entry) => [entry.issue, entry.label]),
    [
      [12, { label: "entail:go", already: false, removed: [] }],
      [14, { label: "entail:no", already: false, removed: [] }],
    ],
  );
  assert.match(h.printed.join("\n"), /acme\/tally#12: posted .*, labelled it entail:go/u);

  // A pass with nothing to act on writes no label again.
  await h.pass();
  assert.deepEqual(h.forge.labelWrites, ["+entail:go #12", "+entail:no #14"]);
});

test("a call waiting to be confirmed is not labelled; the label comes when the confirmation acts, after its window", async (t) => {
  const h = harness(t);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass({ now: () => NOW });
  assert.equal(h.forge.posted.length, 1);
  assert.deepEqual(h.forge.labelsOn(12), []);
  assert.equal(acted(h.dataDirectory)[0]!.label, undefined);

  await confirmCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 12), OWNER, NOW, { holdMs: HOLD_MS });
  await h.pass({ now: () => new Date(NOW.getTime() + 9_999), actOnly: true });
  assert.deepEqual(h.forge.labelsOn(12), [], "nothing while the owner can still undo it");
  await h.pass({ now: () => new Date(NOW.getTime() + 10_000), actOnly: true });
  assert.deepEqual(h.forge.labelsOn(12), ["entail:go"]);
});

test("an override swaps the label: the old call's label comes off and the owner's goes on", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Add a --json flag");
  h.script(14, verdict({ call: "no", reason: "Nobody asked for it." }), verdict({ call: "no", reason: "Still no." }));
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(14), ["entail:no"]);
  await overrideCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 14), OWNER, "go", "Scripts need it.");
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(14), ["entail:go"]);
  assert.deepEqual(h.forge.labelWrites, ["+entail:no #14", "-entail:no #14", "+entail:go #14"]);
  assert.deepEqual(acted(h.dataDirectory).at(-1)!.label, { label: "entail:go", already: false, removed: ["entail:no"] });
});

test("a question is labelled entail:ask while it waits, and the answer swaps in the call it acts as", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Word counts are sometimes wrong");
  h.forge.file(13, "Rewrite tally in Rust");
  const question = { question: "Does a non-breaking space separate words?", why: "Counts differ." };
  h.script(11, verdict({ call: "ask", reason: "Two readings.", question }), verdict({ reason: "The owner chose." }));
  h.script(13, verdict({ call: "ask", reason: "Large.", question }));
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(11), ["entail:ask"], "an ask is labelled even in confirm mode: the question is what waits");
  assert.deepEqual(h.forge.labelsOn(13), ["entail:ask"]);

  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "go", "Yes.");
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 13), OWNER, "no", "Not now.");
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(11), ["entail:go"]);
  assert.deepEqual(h.forge.labelsOn(13), ["entail:no"]);
  assert.deepEqual(h.forge.closed, [13]);
});

test("a re-judgment after an edit that changes the call swaps the label; one that keeps it adds nothing", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict(), verdict(), verdict({ call: "no", reason: "Uploading goes against offline." }));
  await h.pass();
  h.forge.edit(12, { body: "And in endnotes." });
  await h.pass();
  assert.deepEqual(h.forge.labelWrites, ["+entail:go #12"], "the same call again leaves the label as it is");
  assert.equal(acted(h.dataDirectory).at(-1)!.label!.already, true);

  h.forge.edit(12, { body: "Also upload the counts to our server." });
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(12), ["entail:no"]);
  assert.deepEqual(h.forge.labelWrites, ["+entail:go #12", "-entail:go #12", "+entail:no #12"]);
});

test("an account that cannot label: the call still posts and closes, and the repo says why once", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.repoAccess = { cannotLabelAndComment: "the logged-in account has read access only; adding labels needs triage access or more", mayLackMerge: null };
  h.forge.file(14, "Make tally a desktop app");
  h.forge.file(15, "Make tally a web app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  h.script(15, verdict({ call: "no", reason: "Another product." }));
  const report = await h.pass();
  assert.deepEqual(report, { repos: 1, judged: 2, posted: 2, failed: [] });
  assert.deepEqual(h.forge.closed, [14, 15]);
  assert.deepEqual(h.forge.labelWrites, []);
  assert.match(acted(h.dataDirectory)[0]!.label!.failed!, /read access only/u);
  const [view] = repoViews(h.dataDirectory, settings);
  assert.match(view!.cannotLabel!, /read access only/u);
});

test("a label GitHub refuses never holds up the act, and a label that later goes on clears the repo's note", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.refuseLabels = "GitHub answered 500";
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass();
  assert.equal(h.forge.posted.length, 1);
  assert.equal(acted(h.dataDirectory)[0]!.label!.failed, "GitHub answered 500");
  assert.match(h.printed.join("\n"), /could not label it entail:go \(GitHub answered 500\)/u);
  assert.equal(repoViews(h.dataDirectory, settings)[0]!.cannotLabel, "GitHub answered 500");
  assert.deepEqual(await h.pass(), { repos: 1, judged: 0, posted: 0, failed: [] }, "the act is not tried again for its label");

  h.forge.refuseLabels = null;
  h.forge.file(13, "Count words in captions");
  h.script(13, verdict());
  await h.pass();
  assert.deepEqual(h.forge.labelsOn(13), ["entail:go"]);
  assert.equal(repoViews(h.dataDirectory, settings)[0]!.cannotLabel, null);
});

test("a dry run prints the label it would put on and writes none", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  await h.pass({ dryRun: true });
  assert.match(h.printed.join("\n"), /would post on acme\/tally#14 and close it, labelled entail:no:/u);
  assert.deepEqual(h.forge.labelWrites, []);
});
