import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_CASE_BOOK, readLandingCaseBook } from "../src/case-book.ts";
import { commentRuleViolations } from "../src/comment-rules.ts";
import { answerCall, confirmCall, formatLog, formatWaiting, HOLD_MS, itemView, logItems, logPage, overrideCall, undoAction, waitingItems, waitingResponse } from "../src/owner.ts";
import { landingStatuses, readLog, type CallEntry, type LandingEntry, type PrActedEntry } from "../src/records.ts";
import { mergeMethod } from "../src/watch.ts";
import { harness, landingAnswer, OWNER, REPO, verdict, type Harness } from "./watch-fixture.ts";

const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);
const HEAD3 = "3".repeat(40);
const HEAD4 = "4".repeat(40);
const HEAD5 = "5".repeat(40);

const CRITERION = "Words from standard input count toward the same total.";

const landings = (h: Harness): LandingEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is LandingEntry => entry.type === "landing");
const prActs = (h: Harness): PrActedEntry[] => readLog(h.dataDirectory, REPO).filter((entry): entry is PrActedEntry => entry.type === "pr-acted");
const prPosts = (h: Harness, pr: number) => h.forge.posted.filter((post) => post.issue === pr);

/** An issue entail called go on, with one criterion; its call is posted. */
async function goIssue(h: Harness, issue = 1): Promise<void> {
  h.forge.file(issue, "Read standard input", "tally only reads files.");
  h.script(issue, verdict({ criteria: [{ source: "reading", criterion: CRITERION, basis: "One total is what users see." }] }));
  await h.pass();
}

/** The same in confirm mode, with the owner's confirmation acted on: a cleared go, so a PR closing it is judged against its criteria. */
async function clearedGo(h: Harness, issue = 1): Promise<void> {
  await goIssue(h, issue);
  const go = readLog(h.dataDirectory, REPO).findLast((e): e is CallEntry => e.type === "call" && e.issue.number === issue)!;
  await confirmCall(h.dataDirectory, go.id, OWNER);
  await h.pass();
}

const met = (overrides: Parameters<typeof landingAnswer>[0] = {}) =>
  landingAnswer({ criteria: [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }], ...overrides });

const sendBack = (what: string, overrides: Parameters<typeof landingAnswer>[0] = {}) =>
  landingAnswer({
    call: "send-back",
    reason: "Standard input is counted separately.",
    criteria: [{ criterion: CRITERION, met: false, evidence: "src/count.ts prints a second total." }],
    needs_to_change: [what],
    ...overrides,
  });

test("a PR closing an issue entail said go on is judged once CI is green, and merged at the judged head with confirm mode off", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1], body: "Closes #1. CI passes, trust me." });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(
    4,
    met({ beyond: [{ change: "The help text mentions standard input.", sort: "needed", why: "Users need to know it exists." }, { change: "A typo fixed in the README.", sort: "harmless", why: "Small." }] }),
  );

  const report = await h.pass();
  assert.equal(report.judged, 1);
  assert.deepEqual(h.forge.merges, [{ pr: 4, sha: HEAD1, method: "squash" }], "merged at the judged head, squashing");
  const [post] = prPosts(h, 4);
  assert.deepEqual(commentRuleViolations(post!.body, OWNER, landings(h)[0]!.id), []);
  assert.match(post!.body, /^Speaking from Omkar's entail:\n\n\*\*Merge\.\*\* It reads standard input/u);
  assert.match(post!.body, /Criteria:\n\n- Met: Words from standard input count toward the same total\./u);
  assert.match(post!.body, /Beyond the criteria:\n\n- Needed: The help text mentions standard input\.\n- Harmless: A typo fixed in the README\./u);
  assert.match(post!.body, new RegExp(`Merged at \`${HEAD1}\`\\.`, "u"));

  const [landing] = landings(h);
  assert.equal(landing!.head, HEAD1);
  assert.equal(landing!.issueCall, readLog(h.dataDirectory, REPO).find((e): e is CallEntry => e.type === "call")!.id);
  assert.deepEqual(landing!.criteria.map((c) => c.criterion), [CRITERION]);
  assert.deepEqual(landing!.facts.files.map((f) => f.path), ["src/count.ts"], "the changed files come from the forge");
  assert.equal(landing!.facts.checks[0]!.status, "passed");
  assert.match(landing!.prText, /CI passes, trust me/u, "the description is recorded as the author's words");
  assert.equal(landing!.costUsd, 0.07);
  assert.deepEqual(prActs(h)[0]!.merged, { sha: HEAD1, commit: "f".repeat(40) });

  // Merged: no longer followed, nothing more happens.
  const again = await h.pass();
  assert.equal(again.judged, 0);
  assert.equal(h.runner.remaining("pr-call", `${REPO}#4`), 0);
  assert.equal(h.forge.merges.length, 1);
  assert.equal(readLog(h.dataDirectory, REPO).filter((e) => e.type === "unfollowed").length, 1);
});

// PRs with no cleared ticket behind them: judged on the vision alone (#212).

/** A vision-only answer that merges: the product left better, nothing unwanted. */
const better = (overrides: Parameters<typeof landingAnswer>[0] = {}) =>
  landingAnswer({
    reason: "Counting words from standard input makes tally more useful, as the vision asks.",
    solves: { solved: true, evidence: "src/count.ts reads stdin when no file is given." },
    beyond: [{ change: "tally reads standard input when no file is given.", sort: "needed", why: "The vision says tally counts words wherever they come from." }],
    rests_on: { vision_lines: ["tally counts words."], cases: [] },
    ...overrides,
  });

const visionOnly = (h: Harness) => h.runner.requests.filter((r) => r.kind === "pr-call" && r.promptVersion === "pr-call-vision-1");

test("a PR with no ticket behind it is followed, judged on the vision alone once CI is green, merged at the judged head, and logged with its reason", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.openPull(9, "Read standard input", { head: HEAD1, closes: [], body: "Adds stdin." });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(9, better());
  await h.pass();

  const followed = readLog(h.dataDirectory, REPO).filter((e) => e.type === "followed");
  assert.deepEqual(followed.map((e) => e.type === "followed" && e.issue), [null], "followed with no issue");
  const [request] = visionOnly(h);
  assert.ok(request, "the vision-only judgment ran");
  assert.match(request.prompt, /a pull request with no cleared ticket behind it/u);
  assert.match(request.prompt, /There is no issue and there are no criteria to check\./u);
  assert.doesNotMatch(request.prompt, /## The criteria entail set/u);
  assert.doesNotMatch(request.prompt, /## The issue:/u);

  const [landing] = landings(h);
  assert.equal(landing!.issue, null);
  assert.equal(landing!.issueCall, null);
  assert.deepEqual(landing!.criteria, []);
  assert.equal(landing!.promptVersion, "pr-call-vision-1");
  assert.deepEqual(landing!.call.restsOn.visionLines, ["tally counts words."], "the reason cites the vision lines it rests on");
  assert.deepEqual(h.forge.merges, [{ pr: 9, sha: HEAD1, method: "squash" }]);

  const [post] = prPosts(h, 9);
  assert.deepEqual(commentRuleViolations(post!.body, OWNER, landing!.id), []);
  assert.match(post!.body, /^Speaking from Omkar's entail:\n\n\*\*Merge\.\*\* Counting words from standard input/u, "the comment opens as any landing comment does");
  assert.match(post!.body, /No cleared ticket is behind this pull request, so entail judged it on the vision alone\./u);
  assert.match(post!.body, /It rests on the vision:\n\n> tally counts words\./u);
  assert.match(post!.body, /What it does:\n\n- Needed: tally reads standard input/u);
  assert.doesNotMatch(post!.body, /Criteria:/u);

  // The board's Log shows it with no ticket where the issue would be.
  const row = logPage(h.dataDirectory, []).rows.find((one) => one.call.pr?.number === 9)!;
  assert.equal(row.call.issue, null);
  assert.equal(row.call.kind, "pr");
  assert.match(formatLog(logItems(h.dataDirectory, [], REPO), { repoColumn: false }), /Read standard input \(no ticket\)/u);

  // Merged: no longer followed.
  await h.pass();
  assert.equal(h.runner.requests.filter((r) => r.kind === "pr-call").length, 1);
});

test("a PR with no ticket that leaves the product no better, or does something unwanted, is sent back each time and never closed", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.openPull(9, "Rewrite the counter", { head: HEAD1, closes: [] });
  const heads = [HEAD1, HEAD2, HEAD3, HEAD4, HEAD5];
  for (const [index, head] of heads.entries()) {
    if (index > 0) h.forge.editPull(9, { headSha: head });
    h.forge.report(head, ["test", "passed"]);
    h.scriptLanding(
      9,
      landingAnswer({
        call: "send-back",
        reason: "It adds a telemetry call the vision does not ask for.",
        solves: { solved: false, evidence: "Nothing a user sees gets better." },
        beyond: [{ change: "Sends usage data to a server.", sort: "unwanted", why: "The vision says local-first." }],
        needs_to_change: [`Remove the telemetry call, round ${index + 1}.`],
        rests_on: { vision_lines: ["tally runs locally."], cases: [] },
      }),
    );
    await h.pass();
  }
  assert.equal(landings(h).length, 5);
  assert.ok(landings(h).every((one) => !one.cancel), "a PR with no ticket has no ticket to cancel");
  assert.deepEqual(h.forge.closedPulls, []);
  assert.deepEqual(h.forge.merges, []);
  const last = prPosts(h, 9).at(-1)!;
  assert.match(last.body, /\*\*Send back\.\*\* It adds a telemetry call/u);
  assert.match(last.body, /No cleared ticket is behind this pull request/u);
  assert.match(last.body, /What needs to change:\n\n- Remove the telemetry call, round 5\./u);
  assert.match(last.body, /- \*\*Unwanted\*\*: Sends usage data to a server\./u);
  assert.match(last.body, /entail judges it again on its next push\./u);
  assert.equal(prActs(h).filter((one) => one.sentBack).length, 5);
});

test("a merge of a PR with no ticket is still sent back when CI is red at the head", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.openPull(9, "Read standard input", { head: HEAD1, closes: [] });
  h.forge.report(HEAD1, ["test", "failed"]);
  h.scriptLanding(9, better());
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.match(prPosts(h, 9)[0]!.body, /- Make CI green: the check `test` failed\./u);
});

test("a PR with no ticket can be asked about; the owner's answer merges it and writes a landing case with no issue and no criteria", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.openPull(9, "Drop the --lines flag", { head: HEAD1, closes: [] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(9, better({ call: "ask", question: { question: "Drop the --lines flag users rely on?", why: "It removes something users rely on." } }));
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.match(prPosts(h, 9)[0]!.body, /A question about this pull request is waiting for Omkar on entail's board\. Nothing is merged until it is answered\.\n\nNo cleared ticket is behind this pull request/u);

  const [item] = waitingItems(h.dataDirectory, []);
  assert.equal(item!.kind, "pr");
  assert.equal(item!.issue, null);
  assert.equal(item!.pr!.number, 9);
  assert.match(formatWaiting([item!]), /acme\/tally#9 \(PR, no ticket\): Drop the --lines flag/u);

  await answerCall(h.dataDirectory, item!.id, OWNER, "merge", "Nobody uses it; drop it.");
  await h.pass();
  assert.deepEqual(h.forge.merges, [{ pr: 9, sha: HEAD1, method: "squash" }]);
  const [past] = await readLandingCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.issue, null);
  assert.deepEqual(past!.criteria, []);
  assert.equal(past!.issueText, "");
  assert.equal(past!.call, "merge");
  assert.equal(existsSync(join(h.dataDirectory, OWNER_CASE_BOOK, "acme-tally-pr-9", "criteria.md")), false);
});

test("a draft with no ticket, or a PR to another branch, is not followed", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.openPull(9, "Draft", { head: HEAD1, closes: [], draft: true });
  h.forge.openPull(10, "Release branch", { head: HEAD2, closes: [], base: "release" });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.forge.report(HEAD2, ["test", "passed"]);
  await h.pass();
  assert.equal(readLog(h.dataDirectory, REPO).filter((e) => e.type === "followed").length, 0);
  assert.equal(h.runner.requests.filter((r) => r.kind === "pr-call").length, 0);

  // Ready for review: now it is followed and judged.
  h.forge.editPull(9, { draft: false });
  h.scriptLanding(9, better());
  await h.pass();
  assert.equal(landings(h).length, 1);
});

test("a PR linked to an issue entail said no to is judged on the vision alone, and the prompt says where the issue stands", async (t) => {
  const h = harness(t, { confirm: false });
  h.forge.file(2, "Something", "x");
  h.script(2, verdict({ call: "no", reason: "It goes against the vision's local-first line." }));
  await h.pass();
  h.forge.openPull(10, "Implements the no", { head: HEAD2, closes: [2] });
  h.forge.report(HEAD2, ["test", "passed"]);
  h.scriptLanding(10, better({ call: "send-back", solves: { solved: false, evidence: "x" }, needs_to_change: ["Drop it."] }));
  await h.pass();
  const [followed] = readLog(h.dataDirectory, REPO).filter((e) => e.type === "followed");
  assert.equal(followed!.type === "followed" && followed!.issue, null);
  const [request] = visionOnly(h);
  assert.match(request!.prompt, /## Issues it is linked to/u);
  assert.match(request!.prompt, /acme\/tally#2: entail said no to it: It goes against the vision's local-first line\./u);
  assert.deepEqual(landings(h)[0]!.linked, [{ number: 2, standing: "entail said no to it: It goes against the vision's local-first line." }]);
});

test("a PR linked to an issue whose go waits for the owner is judged on the vision alone, then against the go's criteria once the go acts", async (t) => {
  const h = harness(t);
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, better());
  await h.pass();
  const [first] = landings(h);
  assert.equal(first!.issue, null, "the go still waits: no cleared ticket is behind the PR");
  assert.equal(first!.confirm, true, "confirm mode applies as for a linked PR");
  assert.deepEqual(h.forge.merges, []);
  assert.match(visionOnly(h)[0]!.prompt, /acme\/tally#1: entail's go on it waits for the owner to confirm it\./u);
  assert.match(prPosts(h, 4)[0]!.body, /This call waits for Omkar to confirm it on entail's board; nothing is merged until then\./u);

  // The owner confirms the go; it acts, and the PR is followed with its issue and judged again at the same head, against the criteria.
  const go = readLog(h.dataDirectory, REPO).find((e): e is CallEntry => e.type === "call")!;
  await confirmCall(h.dataDirectory, go.id, OWNER);
  h.scriptLanding(4, met());
  await h.pass();
  const follows = readLog(h.dataDirectory, REPO).filter((e) => e.type === "followed");
  assert.deepEqual(follows.map((e) => e.type === "followed" && e.issue), [null, 1]);
  const second = landings(h).at(-1)!;
  assert.equal(second.head, HEAD1);
  assert.equal(second.issue!.number, 1);
  assert.equal(second.issueCall, go.id);
  assert.deepEqual(second.criteria.map((c) => c.criterion), [CRITERION]);
  assert.equal(second.promptVersion, "pr-call-1");
  const linkedPrompt = h.runner.requests.filter((r) => r.kind === "pr-call").at(-1)!.prompt;
  assert.match(linkedPrompt, /a pull request that closes acme\/tally#1/u);
  // The vision-only call it replaced leaves the board: only the call against the criteria waits.
  assert.deepEqual(waitingItems(h.dataDirectory, []).filter((i) => i.kind === "pr").map((i) => i.id), [second.id]);
  await h.pass();
  assert.equal(h.runner.requests.filter((r) => r.kind === "pr-call").length, 2, "and it is not judged a third time");
});

test("a PR is judged only once CI has finished, even with no change to the PR, and a draft waits", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1], draft: true });
  await h.pass();
  assert.equal(landings(h).length, 0, "a draft is followed but not judged");

  h.forge.editPull(4, { draft: false });
  h.forge.report(HEAD1, ["test", "pending"]);
  await h.pass();
  assert.equal(landings(h).length, 0);
  assert.ok(h.printed.some((line) => /waiting for CI to finish at 1111111/u.test(line)));

  // CI finishes: the PR itself does not change, but entail follows it.
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  assert.equal(landings(h).length, 1);
  assert.equal(h.forge.merges.length, 1);
});

test("a head with no checks reported yet is not judged until the window has passed", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  const pushed = Date.parse(h.forge.pulls.get(4)!.updatedAt);
  h.scriptLanding(4, met());
  await h.pass({ now: () => new Date(pushed + 60_000) });
  assert.equal(landings(h).length, 0);
  assert.deepEqual(h.forge.merges, []);
  await h.pass({ now: () => new Date(pushed + 11 * 60_000) });
  assert.equal(landings(h).length, 1);
});

test("a repo that defines CI keeps waiting on a head with no checks, however old", async (t) => {
  const h = harness(t, { confirm: false, definesCI: true });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  const pushed = Date.parse(h.forge.pulls.get(4)!.updatedAt);
  h.scriptLanding(4, met());
  await h.pass({ now: () => new Date(pushed + 60 * 60_000) });
  assert.equal(landings(h).length, 0);
  assert.deepEqual(h.forge.merges, []);
  h.forge.report(HEAD1, ["test", "passed"]);
  await h.pass({ now: () => new Date(pushed + 61 * 60_000) });
  assert.equal(landings(h).length, 1);
});

test("a head whose judgment keeps giving no call is tried three times, then stalls until a new push", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, "fail", "fail", "fail", met());
  for (let i = 0; i < 5; i++) await h.pass();
  assert.equal(h.runner.requests.filter((r) => r.kind === "pr-call").length, 3);
  assert.equal(readLog(h.dataDirectory, REPO).filter((e) => e.type === "landing-failed").length, 3);
  assert.equal(landings(h).length, 0);

  h.forge.editPull(4, { headSha: HEAD2 });
  h.forge.report(HEAD2, ["test", "passed"]);
  await h.pass();
  assert.equal(landings(h).length, 1);
});

test("a send-back posts what needs to change once per head; a new push is judged again, never reused", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, sendBack("Add standard input's words to the one total instead of printing a second total."));
  await h.pass();
  const [first] = prPosts(h, 4);
  assert.match(first!.body, /\*\*Send back\.\*\* Standard input is counted separately\.\n\nWhat needs to change:\n\n- Add standard input's words to the one total/u);
  assert.match(first!.body, /- \*\*Not met\*\*: Words from standard input/u);
  assert.match(first!.body, /entail judges it again on its next push\./u);
  assert.deepEqual(h.forge.merges, []);

  // Nothing changed: no second judgment and no second comment.
  await h.pass();
  assert.equal(prPosts(h, 4).length, 1);
  assert.equal(landings(h).length, 1);

  h.forge.editPull(4, { headSha: HEAD2 });
  h.forge.report(HEAD2, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  assert.deepEqual(h.prReads, [{ pr: 4, head: HEAD1 }, { pr: 4, head: HEAD2 }]);
  const second = h.runner.requests.filter((r) => r.kind === "pr-call")[1]!;
  assert.match(second.prompt, /entail sent this PR back 1 time before/u, "the second judgment reads the earlier send-back");
  assert.deepEqual(h.forge.merges, [{ pr: 4, sha: HEAD2, method: "squash" }]);
});

test("in confirm mode a merge call waits for the owner, the board item carries the PR's checklist, facts and sort, and a confirmation merges", async (t) => {
  const h = harness(t);
  await goIssue(h);
  await confirmCall(h.dataDirectory, readLog(h.dataDirectory, REPO).find((e): e is CallEntry => e.type === "call")!.id, OWNER);
  await h.pass();
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met({ beyond: [{ change: "A loading spinner while counting.", sort: "needed", why: "Counting stdin can take time." }] }));
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.match(prPosts(h, 4)[0]!.body, /This call waits for Omkar to confirm it on entail's board; nothing is merged until then\./u);

  const [item] = waitingItems(h.dataDirectory, []);
  assert.equal(item!.kind, "pr");
  assert.equal(item!.call, "merge");
  assert.equal(item!.issue!.number, 1);
  assert.deepEqual(item!.criteria.map((c) => c.criterion), [CRITERION]);
  assert.equal(item!.pr!.number, 4);
  assert.equal(item!.pr!.head, HEAD1);
  assert.deepEqual(item!.pr!.checklist, [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }]);
  assert.deepEqual(item!.pr!.beyond.map((b) => b.sort), ["needed"]);
  assert.equal(item!.pr!.facts.ciGreen, true);
  assert.deepEqual(item!.pr!.facts.files.map((f) => f.path), ["src/count.ts"]);
  assert.deepEqual(item!.pr!.outcome, { merged: null, refused: null, closed: false }, "posted, nothing merged yet");
  assert.match(item!.posted!.url, /issuecomment/u);
  assert.equal(itemView(h.dataDirectory, item!.id, []).pr!.number, 4);

  await confirmCall(h.dataDirectory, item!.id, OWNER);
  assert.equal(existsSync(join(h.dataDirectory, OWNER_CASE_BOOK, "acme-tally-pr-4")), false, "the case is written when entail acts, not when the owner does");

  await h.pass();
  const [past] = await readLandingCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.slug, "acme-tally-pr-4");
  assert.equal(past!.call, "merge");
  assert.equal(past!.head, HEAD1);
  assert.match(past!.reasonFrom, /confirmed by Omkar on the board/u);
  assert.deepEqual(h.forge.merges, [{ pr: 4, sha: HEAD1, method: "squash" }]);
  assert.match(prPosts(h, 4)[1]!.body, new RegExp(`Omkar confirmed this call on the board: merge\\.\\n\\nMerged at \`${HEAD1}\`\\.`, "u"));
  assert.deepEqual(waitingItems(h.dataDirectory, []), []);
  const view = itemView(h.dataDirectory, item!.id, []);
  assert.equal(view.status, "confirmed");
  assert.deepEqual(view.pr!.outcome?.merged, { sha: HEAD1, commit: "f".repeat(40) });
});

test("a confirmed merge whose head moved since is not merged; the new head is judged again", async (t) => {
  const h = harness(t);
  await clearedGo(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  const [item] = waitingItems(h.dataDirectory, []).filter((i) => i.kind === "pr");
  await confirmCall(h.dataDirectory, item!.id, OWNER);
  h.forge.editPull(4, { headSha: HEAD2 });
  h.forge.report(HEAD2, ["test", "pending"]);
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.match(prActs(h).at(-1)!.refused ?? "", /head moved to `2{40}`/u);
  assert.match(prPosts(h, 4).at(-1)!.body, /entail did not merge it at `1{40}`: its head moved/u);
  assert.equal(landingStatuses(readLog(h.dataDirectory, REPO)).get(item!.id)!.status, "confirmed");
});

test("a merge that changes VISION.md waits on the owner's answer, and their merge lands it", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", {
    head: HEAD1,
    closes: [1],
    files: [
      { path: "VISION.md", status: "modified", previousPath: null, additions: 1, deletions: 0 },
      { path: "src/count.ts", status: "modified", previousPath: null, additions: 3, deletions: 0 },
    ],
  });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.match(prPosts(h, 4)[0]!.body, /A question about this pull request is waiting for Omkar on entail's board\. Nothing is merged until it is answered\./u);
  const [item] = waitingItems(h.dataDirectory, []);
  assert.equal(item!.call, "ask");
  assert.equal(item!.question!.question, "This PR changes VISION.md. Merge it?");
  assert.equal(item!.pr!.guard?.rule, "vision");
  assert.equal(item!.pr!.facts.touched.vision, true);

  await assert.rejects(answerCall(h.dataDirectory, item!.id, OWNER, "go", "yes"), /merge or send-back/u);
  await answerCall(h.dataDirectory, item!.id, OWNER, "merge", "The vision line is mine; merge it.");
  await h.pass();
  assert.deepEqual(h.forge.merges, [{ pr: 4, sha: HEAD1, method: "squash" }]);
  assert.match(prPosts(h, 4)[1]!.body, /\*\*Merge\*\*, on Omkar's answer on the board\.\n\nThe vision line is mine; merge it\./u);
});

test("a pinned path changed makes a merge a question too", async (t) => {
  const h = harness(t, { confirm: false, pins: ["src/count.ts"] });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.equal(landings(h)[0]!.call.question?.question, "This PR changes the pinned path `src/count.ts`. Merge it?");
});

test("CI red at the head: a merge call is sent back mechanically with the failing check", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "failed"], ["lint", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  assert.deepEqual(h.forge.merges, []);
  assert.match(prPosts(h, 4)[0]!.body, /What needs to change:\n\n- Make CI green: the check `test` failed\./u);
  assert.equal(prActs(h)[0]!.sentBack, true);
});

test("after three send-backs the next one cancels: the PR is closed with the reason, and a product call goes to the owner on the issue", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  const heads = [HEAD1, HEAD2, HEAD3, HEAD4];
  for (const [index, head] of heads.entries()) {
    if (index > 0) h.forge.editPull(4, { headSha: head });
    h.forge.report(head, ["test", "passed"]);
    h.scriptLanding(
      4,
      index < 3
        ? sendBack(`Fix it, round ${index + 1}.`)
        : sendBack("Decide whether stdin belongs in the total.", {
            product_call: true,
            question: { question: "Should words from standard input count in the file total, or be reported on their own?", why: "The criterion and the issue's example disagree." },
          }),
    );
    await h.pass();
  }
  assert.deepEqual(h.forge.closedPulls, [4]);
  const last = prPosts(h, 4).at(-1)!;
  assert.match(last.body, /entail has sent this pull request back 3 times before\. Closing it unmerged\./u);
  assert.equal(landings(h).at(-1)!.cancel, true);
  assert.equal(readLog(h.dataDirectory, REPO).filter((e) => e.type === "unfollowed").length, 1);

  // The product call is raised on the issue as a question for the owner, and posted there on the next pass.
  const asks = readLog(h.dataDirectory, REPO).filter((e): e is CallEntry => e.type === "call" && e.trigger === "landing");
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.call.call, "ask");
  await h.pass();
  assert.match(h.forge.posted.filter((p) => p.issue === 1).at(-1)!.body, /A question about this issue is waiting for Omkar on entail's board\./u);
  const question = waitingItems(h.dataDirectory, []).find((item) => item.kind === "issue");
  assert.equal(question!.question!.question, "Should words from standard input count in the file total, or be reported on their own?");

  // The issue's latest call is a question now: a new PR closing it has no cleared ticket behind it, so it is judged on the vision alone.
  h.forge.openPull(5, "Read standard input, again", { head: HEAD5, closes: [1] });
  h.forge.report(HEAD5, ["test", "passed"]);
  await h.pass();
  const calls = h.runner.requests.filter((r) => r.kind === "pr-call");
  assert.equal(calls.length, 5);
  assert.equal(calls[4]!.promptVersion, "pr-call-vision-1");
  assert.match(calls[4]!.prompt, /acme\/tally#1: entail's question on it waits for the owner's answer: Should words from standard input count/u);
});

test("a cancel that is not a product call closes the PR and asks nothing", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  for (const [index, head] of [HEAD1, HEAD2, HEAD3, HEAD4].entries()) {
    if (index > 0) h.forge.editPull(4, { headSha: head });
    h.forge.report(head, ["test", "passed"]);
    h.scriptLanding(4, sendBack(`Fix it, round ${index + 1}.`));
    await h.pass();
  }
  assert.deepEqual(h.forge.closedPulls, [4]);
  assert.equal(readLog(h.dataDirectory, REPO).filter((e) => e.type === "call" && e.trigger === "landing").length, 0);
});

test("the owner overrides a merge with a send-back in their words, recorded and written as a case", async (t) => {
  const h = harness(t);
  await clearedGo(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  const [item] = waitingItems(h.dataDirectory, []).filter((i) => i.kind === "pr");
  await assert.rejects(overrideCall(h.dataDirectory, item!.id, OWNER, "merge", "x"), /already merge; confirm it instead/u);
  await overrideCall(h.dataDirectory, item!.id, OWNER, "send-back", "Keep the README example working too.");
  await h.pass();
  const [past] = await readLandingCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "send-back");
  assert.match(past!.notes, /## entail's call, overridden\n\nentail called merge/u);
  assert.deepEqual(h.forge.merges, []);
  assert.match(prPosts(h, 4).at(-1)!.body, /\*\*Send back\*\*, by Omkar, overriding entail's call on the board\.\n\nKeep the README example working too\./u);
  assert.equal(prActs(h).at(-1)!.sentBack, true);
});

test("an owner's action on a PR held in its window reaches neither GitHub nor the case book until the window closes, and an undone one never does", async (t) => {
  const NOW = new Date("2026-11-12T12:00:00Z");
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const h = harness(t);
  await clearedGo(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass({ now: () => NOW });
  const [item] = waitingItems(h.dataDirectory, []).filter((i) => i.kind === "pr");
  const postsBefore = prPosts(h, 4).length;
  const caseDirectory = join(h.dataDirectory, OWNER_CASE_BOOK, "acme-tally-pr-4");

  // Confirmed and held: the board shows it as held and nothing else happens.
  const action = await confirmCall(h.dataDirectory, item!.id, OWNER, NOW, { holdMs: HOLD_MS });
  assert.equal(action.holdUntil, "2026-11-12T12:00:10.000Z");
  assert.deepEqual(waitingItems(h.dataDirectory, []).filter((one) => one.kind === "pr"), []);
  const held = waitingResponse(h.dataDirectory, [], { now: at(1_000) }).held;
  assert.deepEqual(held.map((one) => [one.item.kind, one.item.id]), [["pr", item!.id]]);
  await h.pass({ now: () => at(9_999), actOnly: true });
  assert.equal(prPosts(h, 4).length, postsBefore);
  assert.deepEqual(h.forge.merges, []);
  assert.equal(existsSync(caseDirectory), false);

  // Undone: the call waits again, and a later pass does nothing for it.
  const { call } = undoAction(h.dataDirectory, item!.id, OWNER, at(5_000));
  assert.equal(call.status, "waiting");
  assert.deepEqual(waitingItems(h.dataDirectory, []).filter((one) => one.kind === "pr").map((one) => one.id), [item!.id]);
  await h.pass({ now: () => at(60_000), actOnly: true });
  assert.deepEqual(h.forge.merges, []);
  assert.equal(existsSync(caseDirectory), false);

  // Overridden and held, then the window closes: the case is written, then the PR is sent back.
  await overrideCall(h.dataDirectory, item!.id, OWNER, "send-back", "Not this release.", at(61_000), { holdMs: HOLD_MS });
  await h.pass({ now: () => at(70_999), actOnly: true });
  assert.equal(existsSync(caseDirectory), false);
  assert.equal(prPosts(h, 4).length, postsBefore);
  await h.pass({ now: () => at(71_000), actOnly: true });
  const [past] = await readLandingCaseBook(join(h.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "send-back");
  assert.match(prPosts(h, 4).at(-1)!.body, /Not this release\./u);
  assert.deepEqual(h.forge.merges, []);
  assert.throws(() => undoAction(h.dataDirectory, item!.id, OWNER, at(65_000)), /too late to undo/u);
});

test("a PR merged or closed by someone else is no longer followed, and its waiting call leaves the board", async (t) => {
  const h = harness(t);
  await clearedGo(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  await h.pass();
  assert.equal(waitingItems(h.dataDirectory, []).filter((i) => i.kind === "pr").length, 1);
  h.forge.editPull(4, { state: "merged" });
  await h.pass();
  assert.equal(waitingItems(h.dataDirectory, []).filter((i) => i.kind === "pr").length, 0);
  assert.equal(landingStatuses(readLog(h.dataDirectory, REPO)).get(landings(h)[0]!.id)!.status, "closed");
});

test("a refused merge is recorded with the forge's reason, and the merge follows the repo's merge settings", async (t) => {
  assert.equal(mergeMethod(["merge", "rebase"]), "merge");
  assert.equal(mergeMethod(["rebase"]), "rebase");
  assert.equal(mergeMethod([]), "squash");
  assert.equal(mergeMethod(null), "squash");

  const h = harness(t, { confirm: false });
  h.forge.methods = ["rebase"];
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.forge.refuseMerge = "Pull request is not mergeable: conflicts";
  h.scriptLanding(4, met());
  await h.pass();
  assert.equal(prActs(h)[0]!.refused, "Pull request is not mergeable: conflicts");
  assert.match(prPosts(h, 4)[0]!.body, /entail did not merge it at `1{40}`: Pull request is not mergeable: conflicts\. A new push gets it judged again\./u);

  const h2 = harness(t, { confirm: false });
  h2.forge.methods = ["rebase"];
  await goIssue(h2);
  h2.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h2.forge.report(HEAD1, ["test", "passed"]);
  h2.scriptLanding(4, met());
  await h2.pass();
  assert.deepEqual(h2.forge.merges, [{ pr: 4, sha: HEAD1, method: "rebase" }]);
});

test("a landing judgment that gives no call is tried again next pass, and nothing is posted for it", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, "fail");
  await h.pass();
  assert.equal(landings(h).length, 0);
  assert.equal(prPosts(h, 4).length, 0);
  h.scriptLanding(4, met());
  await h.pass();
  assert.equal(h.forge.merges.length, 1);
});

test("a dry run judges a PR and prints what it would post and merge, and changes nothing", async (t) => {
  const h = harness(t, { confirm: false });
  await goIssue(h);
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, met());
  const before = readLog(h.dataDirectory, REPO).length;
  const report = await h.pass({ dryRun: true });
  assert.equal(report.judged, 1);
  assert.equal(readLog(h.dataDirectory, REPO).length, before, "nothing is recorded");
  assert.deepEqual(h.forge.merges, []);
  assert.equal(prPosts(h, 4).length, 0);
  assert.ok(h.printed.some((line) => line.startsWith(`would post on ${REPO}#4, then merge at ${HEAD1}:`)));
  assert.ok(h.printed.some((line) => line.includes("following the pull request")));
});

test("a go confirmed but still in its undo window is not cleared yet: a PR linked to it stays judged on the vision alone", async (t) => {
  const NOW = new Date("2026-11-18T12:00:00Z");
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const h = harness(t);
  await goIssue(h);
  const go = readLog(h.dataDirectory, REPO).find((e): e is CallEntry => e.type === "call")!;
  await confirmCall(h.dataDirectory, go.id, OWNER, NOW, { holdMs: HOLD_MS });
  h.forge.openPull(4, "Read standard input", { head: HEAD1, closes: [1] });
  h.forge.report(HEAD1, ["test", "passed"]);
  h.scriptLanding(4, better(), met());
  await h.pass({ now: () => at(1_000) });
  assert.equal(landings(h)[0]!.issue, null, "the confirmation can still be undone");

  // The window closes: the go acts, and the PR is followed with its issue and judged against the criteria.
  await h.pass({ now: () => at(HOLD_MS + 1) });
  await h.pass({ now: () => at(HOLD_MS + 2) });
  assert.equal(landings(h).at(-1)!.issue?.number, 1);
});
