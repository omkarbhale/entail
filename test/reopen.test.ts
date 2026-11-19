import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { answerCall, confirmCall, latestCallOn, waitingItems } from "../src/owner.ts";
import { pendingReopens, readLog, type CallEntry, type ReopenedEntry } from "../src/records.ts";
import { harness, OWNER, verdict, type Harness } from "./watch-fixture.ts";

const LINE = "New features are opt-in.";

const NO = verdict({ call: "no", reason: "A feature that is on by default breaks the vision.", rests_on: { vision_lines: [LINE], cases: [] } });

const calls = (h: Harness): CallEntry[] => readLog(h.dataDirectory, h.repo).filter((entry): entry is CallEntry => entry.type === "call");
const reopens = (h: Harness): ReopenedEntry[] => readLog(h.dataDirectory, h.repo).filter((entry): entry is ReopenedEntry => entry.type === "reopened");

/** An issue entail called no on and closed, with its comment posted. */
async function closedByEntail(t: TestContext, forge: "github" | "gitlab", confirm = false): Promise<Harness> {
  const h = harness(t, { confirm, forge });
  h.forge.file(12, "Turn on word counts by default");
  h.script(12, NO);
  await h.pass();
  if (confirm) {
    await confirmCall(h.dataDirectory, latestCallOn(h.dataDirectory, h.repo, 12), OWNER);
    await h.pass();
  }
  assert.deepEqual(h.forge.closed, [12], "entail closed the issue with its no");
  return h;
}

for (const kind of ["github", "gitlab"] as const) {
  test(`${kind}: the owner reopening an issue entail closed brings it to the board as a question carrying the no and the vision line, with no model run`, async (t) => {
    const h = await closedByEntail(t, kind);
    const owner = await h.forge.currentActor();
    h.forge.reopen(12, owner);
    const runs = h.runner.requests.length;
    const report = await h.pass();

    assert.equal(h.runner.requests.length, runs, "no model run answers the owner's reopen");
    assert.equal(report.judged, 0);
    const [entry] = reopens(h);
    assert.deepEqual(entry!.by, { username: "omkarbhale", owner: true });
    const question = calls(h).at(-1)!;
    assert.equal(question.trigger, "owner-reopen");
    assert.equal(question.call.call, "ask");
    assert.deepEqual(question.call.restsOn.visionLines, [LINE]);
    assert.match(question.call.call === "ask" ? question.call.question : "", /closed this issue with a no: A feature that is on by default breaks the vision\./u);
    assert.deepEqual(pendingReopens(readLog(h.dataDirectory, h.repo)).size, 0, "a call answers the reopen");

    const [item] = waitingItems(h.dataDirectory, []);
    assert.equal(item!.call, "ask");
    assert.equal(item!.trigger, "owner-reopen");
    assert.deepEqual(item!.restsOn.visionLines.map((one) => one.text), [LINE]);

    // The issue and its last comment say where it stands.
    assert.deepEqual(h.forge.labelsOn(12), ["entail:ask"]);
    const last = h.forge.posted.at(-1)!;
    assert.match(last.body, /Omkar reopened this issue after entail closed it with a no, so it is theirs to settle/u);
    assert.match(last.body, /> New features are opt-in\./u);
    assert.deepEqual(h.forge.closed, [12], "nothing closes it again");
    assert.deepEqual(h.forge.reopened, [], "entail did not reopen anything itself");

    // The same reopen is not asked twice.
    assert.deepEqual(await h.pass(), { repos: 1, judged: 0, posted: 0, failed: [] });
    assert.equal(calls(h).length, 2);
  });

  test(`${kind}: the owner's answer to the reopen question settles the ticket, recorded under their name`, async (t) => {
    const h = await closedByEntail(t, kind);
    h.forge.reopen(12, await h.forge.currentActor());
    await h.pass();
    h.script(12, verdict({ reason: "The owner wants it opt-in by flag.", criteria: [{ source: "answer", criterion: "Counting stays opt-in.", basis: "The owner's answer." }] }));
    const id = latestCallOn(h.dataDirectory, h.repo, 12);
    const answered = await answerCall(h.dataDirectory, id, OWNER, "go", "Yes, but behind a flag.");
    assert.equal(answered.by, OWNER);
    const report = await h.pass();
    assert.equal(report.judged, 1);
    assert.match(h.runner.requests.at(-1)!.prompt, /The owner's answer: go\.\n\nYes, but behind a flag\./u);
    assert.match(h.forge.posted.at(-1)!.body, /\*\*Go\*\*, on Omkar's answer on the board/u);
    assert.deepEqual(h.forge.labelsOn(12), ["entail:go"]);
  });

  test(`${kind}: a no answer to the reopen question closes the issue again under the owner's words`, async (t) => {
    const h = await closedByEntail(t, kind);
    h.forge.reopen(12, await h.forge.currentActor());
    await h.pass();
    await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, h.repo, 12), OWNER, "no", "On reflection the vision is right.");
    await h.pass();
    assert.deepEqual(h.forge.closed, [12, 12]);
    assert.match(h.forge.posted.at(-1)!.body, /\*\*No\*\*, on Omkar's answer on the board\./u);
  });

  test(`${kind}: someone else's reopen is not the owner's word: the issue is judged again, and a no closes it again even in confirm mode`, async (t) => {
    const h = await closedByEntail(t, kind, true);
    h.forge.reopen(12, h.forge.account(3003, "collaborator"));
    h.script(12, NO);
    const report = await h.pass();

    assert.equal(report.judged, 1, "the normal intake call runs on the issue's current text");
    const [entry] = reopens(h);
    assert.deepEqual(entry!.by, { username: "collaborator", owner: false });
    const again = calls(h).at(-1)!;
    assert.equal(again.trigger, "reopen");
    assert.equal(again.owner, null, "it is not an override");
    assert.equal(again.call.call, "no");
    assert.deepEqual(waitingItems(h.dataDirectory, []), [], "it is not raised as the owner's question");
    assert.deepEqual(h.forge.closed, [12, 12], "closed again, with its reason");
    assert.match(h.forge.posted.at(-1)!.body, /\*\*No\.\*\* A feature that is on by default/u);
    assert.deepEqual(h.forge.labelsOn(12), ["entail:no"]);
  });

  test(`${kind}: someone else's reopen that now reads as a go starts as any go does`, async (t) => {
    const h = await closedByEntail(t, kind);
    h.forge.edit(12, { body: "Make it a flag, off by default." });
    h.forge.reopen(12, h.forge.account(3003, "collaborator"));
    h.script(12, verdict({ criteria: [{ source: "reading", criterion: "Off by default.", basis: "The vision." }] }));
    await h.pass();
    assert.equal(calls(h).at(-1)!.call.call, "go");
    assert.deepEqual(h.forge.labelsOn(12), ["entail:go"]);
    assert.equal(calls(h).at(-1)!.owner, null);
  });

  test(`${kind}: a reopen the forge names no one for is nobody's word, and a failed judgment is tried again next pass`, async (t) => {
    const h = await closedByEntail(t, kind);
    h.forge.reopen(12, null);
    h.script(12, "fail", NO);
    const first = await h.pass();
    assert.deepEqual(first.failed, [h.repo]);
    assert.equal(pendingReopens(readLog(h.dataDirectory, h.repo)).size, 1, "the reopen still waits for its call");
    const second = await h.pass();
    assert.equal(second.judged, 1);
    assert.deepEqual(reopens(h).map((entry) => entry.by), [null]);
    assert.deepEqual(h.forge.closed, [12, 12]);
    assert.equal(calls(h).at(-1)!.trigger, "reopen");
    assert.equal(pendingReopens(readLog(h.dataDirectory, h.repo)).size, 0);
  });
}
