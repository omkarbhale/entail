import assert from "node:assert/strict";
import { test } from "node:test";
import { VISION_GROWTH_KIND, VISION_GROWTH_PROMPT_VERSION, addVisionLine, checkGrowth, type VisionGrowthAnswer } from "../src/vision-growth.ts";
import { answerCall, formatLog, HOLD_MS, latestCallOn, logItems, undoAction } from "../src/owner.ts";
import { Notifier, grownLine } from "../src/notices.ts";
import { GROWTH_STARTS_AT, pendingGrowth, readLog, repoState, visionGrowth, type VisionConsideredEntry, type VisionGrownEntry } from "../src/records.ts";
import { harness, landingAnswer, NO_GROWTH, OWNER, REPO, verdict, VISION, type Harness } from "./watch-fixture.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERAL: VisionGrowthAnswer = {
  general: true,
  line: "tally never reads a file the user did not name.",
  heading: "Vision",
  reason: "The answer says tally never reads files beyond the ones named, which holds for every feature that reads input.",
};

const considered = (h: Harness): VisionConsideredEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is VisionConsideredEntry => entry.type === "vision-considered");
const grown = (h: Harness): VisionGrownEntry[] => visionGrowth(readLog(h.dataDirectory, REPO));
const growthRuns = (h: Harness) => h.runner.requests.filter((request) => request.kind === VISION_GROWTH_KIND);

/** An issue asked about, and the owner's answer to it, with the pass that acts on it. */
async function answered(h: Harness, number = 11, to = "go", words = "Yes, but never read a file the user did not name."): Promise<void> {
  h.forge.file(number, "Count words in every file under a directory");
  h.script(number, verdict({ call: "ask", reason: "Reading a whole tree is not what the vision describes.", question: { question: "Should tally walk a directory?", why: "It changes what tally reads." } }));
  if (to === "go") h.script(number, verdict({ reason: "The owner approved it.", criteria: [{ source: "answer", criterion: "It never reads a file the user did not name.", basis: words }] }));
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, number), OWNER, to, words);
  await h.pass();
}

test("an answer that makes sense as a general statement is written into VISION.md, with its origin recorded outside it", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, GENERAL);
  await answered(h);

  assert.equal(h.forge.fileCommits.length, 1);
  assert.equal(h.forge.visionFile, "# Vision\n\ntally counts words offline.\nNew features are opt-in.\ntally never reads a file the user did not name.\n");
  assert.doesNotMatch(h.forge.visionFile!, /Omkar|#11|answer|automatic/u, "VISION.md carries no mark of its origin");
  assert.match(h.forge.fileCommits[0]!.message, /board answer on #11/u);
  assert.doesNotMatch(h.forge.fileCommits[0]!.message, /Omkar/u);

  const [added] = grown(h);
  assert.equal(added!.by, OWNER);
  assert.equal(added!.about.number, 11);
  assert.equal(added!.about.kind, "issue");
  assert.equal(added!.line, GENERAL.line);
  assert.equal(added!.commit, h.forge.fileCommits[0]!.commit);
  assert.equal(added!.answer, considered(h)[0]!.answer);
  const request = growthRuns(h)[0]!;
  assert.equal(request.promptVersion, VISION_GROWTH_PROMPT_VERSION);
  assert.match(request.prompt, /tally counts words offline\./u);
  assert.match(request.prompt, /Should tally walk a directory\?/u);
  assert.match(request.prompt, /Omkar answered go/u);
  assert.ok(h.printed.some((text) => /added to VISION\.md automatically, from Omkar's answer on acme\/tally#11/u.test(text)));
});

test("the weighing runs once: a later pass neither runs the model nor writes again", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, GENERAL);
  await answered(h);
  await h.pass();
  await h.pass();
  assert.equal(growthRuns(h).length, 1);
  assert.equal(h.forge.fileCommits.length, 1);
  assert.equal(grown(h).length, 1);
});

test("most answers add nothing: the decision is logged with its reason and VISION.md is not touched", async (t) => {
  const h = harness(t);
  await answered(h, 11, "no", "Not this release.");
  assert.deepEqual(h.forge.fileCommits, []);
  assert.deepEqual(grown(h), []);
  const [decision] = considered(h);
  assert.equal(decision!.decision.add, false);
  assert.match(decision!.decision.reason, /this ticket only/u);
  assert.ok(h.printed.some((text) => /settles this ticket only; nothing added to the vision/u.test(text)));
  await h.pass();
  assert.equal(growthRuns(h).length, 1);
});

test("a line the vision already says is not added twice", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, { ...GENERAL, line: "New features are opt-in." });
  await answered(h);
  assert.deepEqual(h.forge.fileCommits, []);
  assert.match(considered(h)[0]!.decision.reason, /the vision already says it/u);
});

test("an answer is weighed only once its undo window has closed, and never when it was undone", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Count words in every file under a directory");
  h.script(11, verdict({ call: "ask", question: { question: "Should tally walk a directory?", why: "It changes what tally reads." } }));
  await h.pass();
  const now = new Date();
  const action = await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "No.", now, { holdMs: HOLD_MS });
  await h.pass({ now: () => now });
  assert.equal(growthRuns(h).length, 0, "held");
  undoAction(h.dataDirectory, action.call, OWNER, now);
  await h.pass({ now: () => new Date(now.getTime() + 2 * HOLD_MS) });
  assert.equal(growthRuns(h).length, 0, "undone");
  assert.deepEqual(considered(h), []);
});

test("answers given before the vision grew from answers are never weighed", async (t) => {
  const h = harness(t);
  h.forge.file(11, "Count words in every file under a directory");
  h.script(11, verdict({ call: "ask", question: { question: "Should tally walk a directory?", why: "It changes what tally reads." } }));
  await h.pass();
  const before = new Date(Date.parse(GROWTH_STARTS_AT) - 1000);
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "No.", before);
  assert.deepEqual(pendingGrowth(readLog(h.dataDirectory, REPO), new Date()), []);
  await h.pass();
  assert.equal(growthRuns(h).length, 0);
});

test("a forge that refuses the write is tried again next pass without another model run", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, GENERAL);
  h.forge.refuseFileCommit = "Protected branch update failed";
  await answered(h);
  assert.deepEqual(grown(h), []);
  assert.equal(considered(h).length, 1);
  assert.ok(h.printed.some((text) => /could not write the line into VISION\.md: .*Protected branch update failed; it tries again next pass/u.test(text)));
  await h.pass();
  assert.equal(growthRuns(h).length, 1);
  assert.equal(grown(h).length, 1);
  assert.equal(h.forge.fileCommits.length, 1);
});

test("a line committed before entail could record it is recorded as grown with its commit on the next pass, and the owner is told", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, GENERAL);
  h.forge.failAfterFileCommit = true;
  await answered(h);
  assert.equal(h.forge.fileCommits.length, 1);
  assert.deepEqual(grown(h), []);
  await h.pass();
  assert.equal(h.forge.fileCommits.length, 1);
  assert.equal(growthRuns(h).length, 1);
  const [entry] = grown(h);
  assert.equal(entry!.line, GENERAL.line);
  assert.equal(entry!.commit, h.forge.fileCommits[0]!.commit);
  assert.ok(h.printed.some((text) => /added to VISION\.md automatically/u.test(text)));
  assert.equal(considered(h).at(-1)!.decision.add, true);
});

test("a run that gave no decision is tried again next pass", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, "fail", GENERAL);
  await answered(h);
  assert.deepEqual(considered(h), []);
  assert.ok(h.printed.some((text) => /weighing the answer for the vision gave no decision \(error\)/u.test(text)));
  await h.pass();
  assert.equal(grown(h).length, 1);
});

test("a repo with no VISION.md grows nothing", async (t) => {
  const h = harness(t);
  h.forge.visionFile = null;
  h.scriptGrowth(11, GENERAL);
  await answered(h);
  assert.deepEqual(h.forge.fileCommits, []);
  assert.deepEqual(grown(h), []);
  assert.equal(considered(h).at(-1)!.decision.add, false);
});

test("the next pass sees the changed vision and re-checks the open calls made under the old one, flagging the PR that relied on it", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(12, "Read every file under a directory too", "tally should read whole trees.");
  h.script(12, verdict({ reason: "Reading more is useful." }));
  await h.pass();
  h.forge.openPull(40, "Read trees", { head: "d".repeat(40), closes: [12], draft: true });
  await h.pass();
  h.forge.file(11, "Count words in every file under a directory");
  h.script(11, verdict({ call: "ask", question: { question: "Should tally walk a directory?", why: "It changes what tally reads." } }));
  h.scriptGrowth(11, GENERAL);
  await h.pass();
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "no", "No: never read a file the user did not name.");
  await h.pass();
  const text = h.forge.visionFile!;
  assert.equal(grown(h).length, 1);

  // The vision on the base branch now reads differently; the same pass that sees it re-checks.
  h.runner.script("issue-call", `${REPO}#12`, {
    output: { ...verdict({ call: "no", reason: "The vision now says tally never reads a file the user did not name." }), rests_on: { vision_lines: [GENERAL.line], cases: [] }, vision_change: GENERAL.line },
    facts: { estimatedCostUsd: 0.06 },
  });
  await h.pass({ reader: async () => ({ checkout: "/checkout", sha: "e".repeat(40), vision: { text, commit: "e".repeat(40) }, pins: [] }) });
  const log = readLog(h.dataDirectory, REPO);
  const seen = log.filter((entry) => entry.type === "vision-seen");
  assert.equal(seen.length, 1);
  assert.deepEqual(visionLinesAdded(seen[0]!), [GENERAL.line]);
  assert.equal(repoState(REPO, log).vision!.text, text);
  const moved = log.filter((entry) => entry.type === "call" && entry.trigger === "vision");
  assert.equal(moved.length, 1);
  assert.ok(h.forge.posted.some((post) => /relied on the old text|vision changed/iu.test(post.body)), "the PR that relied on the old text is told");
});

function visionLinesAdded(entry: unknown): string[] {
  const { text, from } = entry as { text: string; from: string | null };
  assert.ok(from === null || typeof from === "string");
  return text.split("\n").filter((line) => line === GENERAL.line);
}

test("the log and `entail calls` show each line with where it came from", async (t) => {
  const h = harness(t);
  h.scriptGrowth(11, GENERAL);
  await answered(h);
  const text = formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false });
  assert.match(text, /added to VISION\.md under "Vision" automatically, from Omkar's answer on the board/u);
  assert.ok(text.includes(GENERAL.line));
});

test("an answer to a question about a PR with no ticket is weighed the same way", async (t) => {
  const h = harness(t, { confirm: false });
  const HEAD = "1".repeat(40);
  h.forge.openPull(9, "Drop the --lines flag", { head: HEAD, closes: [] });
  h.forge.report(HEAD, ["test", "passed"]);
  h.scriptLanding(9, landingAnswer({ call: "ask", question: { question: "Drop the --lines flag users rely on?", why: "It removes something users rely on." } }));
  await h.pass();
  const [waiting] = (await import("../src/owner.ts")).waitingItems(h.dataDirectory, []);
  h.scriptGrowth(9, { ...GENERAL, line: "tally keeps the flags users rely on until the owner says otherwise." });
  await answerCall(h.dataDirectory, waiting!.id, OWNER, "send-back", "Keep it: tally keeps the flags users rely on.");
  await h.pass();
  const [added] = grown(h);
  assert.equal(added!.about.kind, "pr");
  assert.equal(added!.about.number, 9);
  assert.match(growthRuns(h)[0]!.prompt, /Drop the --lines flag users rely on\?/u);
  assert.match(h.forge.fileCommits[0]!.message, /board answer on PR #9/u);
});

// The placement and the checks.

test("a line goes at the end of the section under the heading the model chose, and nothing else in the file moves", () => {
  const text = "# Vision\n\nIntro line.\n\n## Calls\n\nFirst call line.\nSecond call line.\n\n## How it runs\n\nIt runs.\n";
  assert.equal(addVisionLine(text, "New call line.", "Calls"), "# Vision\n\nIntro line.\n\n## Calls\n\nFirst call line.\nSecond call line.\nNew call line.\n\n## How it runs\n\nIt runs.\n");
});

test("a line whose heading is not in the file goes at the end, and a file with no final newline gets one", () => {
  assert.equal(addVisionLine("# Vision\n\nIntro line.", "Last line.", "Nowhere"), "# Vision\n\nIntro line.\nLast line.\n");
  assert.equal(addVisionLine("# Vision\n\nIntro line.\n", "Last line.", null), "# Vision\n\nIntro line.\nLast line.\n");
});

test("a heading with nothing under it takes the line after the heading, and Windows line endings are kept", () => {
  assert.equal(addVisionLine("# Vision\r\n\r\n## Empty\r\n\r\n## Next\r\n\r\nA line.\r\n", "New.", "Empty"), "# Vision\r\n\r\n## Empty\r\nNew.\r\n\r\n## Next\r\n\r\nA line.\r\n");
});

test("a line the file already has, in any spacing, is not added", () => {
  assert.equal(addVisionLine("# Vision\n\nNew   features are opt-in.\n", "New features are opt-in.", null), null);
});

test("a decision that is not a usable line adds nothing, with the reason", () => {
  const vision = { text: VISION };
  assert.equal(checkGrowth({ ...GENERAL, general: false }, vision).add, false);
  for (const line of ["", "  ", "two\nlines", "# A heading", "- ", "x".repeat(401), "New features are opt-in."]) {
    const decision = checkGrowth({ ...GENERAL, line }, vision);
    assert.equal(decision.add, false, JSON.stringify(line));
    assert.match(decision.reason, /Nothing was added/u);
  }
  assert.deepEqual(checkGrowth(GENERAL, vision), { add: true, line: GENERAL.line, heading: "Vision", reason: GENERAL.reason });
  assert.equal(checkGrowth(GENERAL, null).add, false);
});

test("the owner is told once of each line added, with the line and a link to VISION.md at the commit, and a failed notice is tried again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "entail-notice-"));
  try {
    const sent: { line: string; link: string }[] = [];
    let fail = true;
    const notifier = new Notifier({
      dataDirectory: directory,
      command: () => "notify",
      link: "http://127.0.0.1:4380/#/waiting",
      send: async (_command, line, link) => {
        sent.push({ line, link });
        return fail ? { ok: false, error: "exited 1" } : { ok: true };
      },
    });
    const item = { repo: REPO, grown: { id: 5, by: OWNER, about: { kind: "issue" as const, number: 11 }, line: GENERAL.line, commit: "c".repeat(40) } };
    assert.deepEqual(await notifier.grown([item]), []);
    fail = false;
    assert.deepEqual(await notifier.grown([item]), [grownLine(REPO, item.grown)]);
    assert.deepEqual(await notifier.grown([item]), []);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.link, `https://github.com/acme/tally/blob/${"c".repeat(40)}/VISION.md`);
    assert.equal(sent[1]!.line, `entail: added to acme/tally's VISION.md from Omkar's answer on #11: ${GENERAL.line}`);
    assert.match(readFileSync(join(directory, "notices.json"), "utf8"), /acme\/tally#5/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unweighed answer is no growth entry until the run decides", () => {
  assert.deepEqual(NO_GROWTH.general, false);
});

test("a line already in VISION.md from a commit made for another answer is not recorded as this answer's growth", async (t) => {
  const h = harness(t);
  h.forge.visionFile = `${h.forge.visionFile}${GENERAL.line}\n`;
  h.forge.fileCommits.push({ path: "VISION.md", content: h.forge.visionFile, message: `Add a line to VISION.md from a board answer on #11\n\n${GENERAL.line}\n\nBoard answer 1`, commit: "a".repeat(40) });
  h.scriptGrowth(11, GENERAL);
  await answered(h);
  assert.deepEqual(grown(h), []);
  assert.equal(h.forge.fileCommits.length, 1);
  assert.equal(considered(h).at(-1)!.decision.add, false);
});
