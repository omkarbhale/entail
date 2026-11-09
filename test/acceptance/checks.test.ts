import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditedIssue, AuditedPullRequest } from "./audit.ts";
import { attributionFor, checkRun, isExecutorComment, judge, type RunReport, type TicketReport } from "./checks.ts";
import { renderEvidence } from "./comments.ts";
import type { RunEvidence, StoreCall, StoreForgeWrite } from "./evidence.ts";
import { FIXTURE_ISSUES, startingTree, type TicketId } from "./fixture.ts";
import { PREPARED_CHANGES } from "./prepared.ts";

const VISION = startingTree().get("VISION.md")!;
const SHA = "a".repeat(40);
const OWNER = "Omkar";
const ATTRIBUTION = "Speaking from Omkar's entail:";
const META = { run: 1, startedAt: "2026-11-09T10:00:00Z", finishedAt: "2026-11-09T11:00:00Z", settled: true };

/** A run in which every fixture issue was filed (#1…#11) and nothing else happened. */
function evidence(): RunEvidence {
  const issueNumbers: Partial<Record<TicketId, number>> = {};
  FIXTURE_ISSUES.forEach((f, i) => (issueNumbers[f.id] = i + 1));
  return {
    forge: "github",
    repo: "o/entail-fixture-tally",
    ownerName: OWNER,
    boardOrigin: "http://127.0.0.1:7419",
    issueNumbers,
    startingVision: VISION,
    finalVision: VISION,
    visionAt: { [SHA]: VISION },
    issues: FIXTURE_ISSUES.map((f, i) => issue(i + 1, f.title)),
    pullRequests: [],
    store: { tickets: [], calls: [], boardItems: [], forgeWrites: [], visionChanges: [], visionLineOrigins: [], enrollmentModelRuns: [] },
    notices: [],
    callsPageIds: [],
    records: [],
    events: [],
    restart: { stoppedAt: "2026-11-09T10:30:00Z", startedAt: "2026-11-09T10:30:05Z", ticketsBefore: [] },
  };
}

function issue(number: number, title: string): AuditedIssue {
  return { number, title, body: "", state: "open", stateReason: null, labels: [], comments: [], labelEvents: [] };
}

let nextCall = 1;
function call(ticketId: number, fields: Partial<StoreCall>): StoreCall {
  return {
    id: nextCall++,
    ticketId,
    madeAt: "2026-11-09T10:05:00Z",
    kind: "verdict",
    reason: "because",
    citation: null,
    answerId: null,
    noContradictionFound: false,
    checks: null,
    challenge: null,
    inputs: { issueTitle: "t", issueBody: "b", visionSha: SHA, pins: [], settingsVersionId: 2, prHeadSha: null },
    detail: null,
    stateFrom: null,
    stateTo: null,
    modelRuns: [{ id: nextCall, callId: 0, purpose: "verdict", model: "m", durationMs: 1, estimatedCostUsd: 0.5 }],
    ...fields,
  };
}

/** Takes in the ticket for a fixture id, as ticket id = issue number. */
function takeIn(e: RunEvidence, id: TicketId, state: string): number {
  const number = e.issueNumbers[id]!;
  e.store.tickets.push({ id: number, issueNumber: number, predecessorId: null, takenInAt: META.startedAt, state });
  return number;
}

function failuresOf(report: RunReport, check: number): string[] {
  return report.checks.find((c) => c.id === check)!.failures;
}

function ticket(report: RunReport, id: TicketId): TicketReport {
  return report.tickets.find((t) => t.id === id)!;
}

test("the attribution line names the owner in the possessive", () => {
  assert.equal(attributionFor("Omkar"), "Speaking from Omkar's entail:");
  assert.equal(attributionFor("James"), "Speaking from James' entail:");
  assert.equal(attributionFor("Omkar's"), "Speaking from Omkar's entail:");
});

test("the executor's findings and evidence are its own, not entail's", () => {
  assert.equal(isExecutorComment("## entail findings\n\nQ1: x"), true);
  const evidence = renderEvidence(PREPARED_CHANGES.get("T1")!, { id: 5, body: "C1: x", createdAt: "", author: "" }, SHA, {
    passed: true,
    pass: 1,
    fail: 0,
    output: "",
  });
  assert.equal(isExecutorComment(evidence), true);
  assert.equal(isExecutorComment(`${ATTRIBUTION}\n\nhi\n<!-- entail ticket 1 -->`), false);
});

test("clearing T7 without an answer is a wrong clear and fails check 1", () => {
  const e = evidence();
  const t = takeIn(e, "T7", "cleared");
  e.store.calls.push(call(t, { kind: "criteria", stateFrom: "deciding", stateTo: "cleared", detail: { verdict: "unopposed", criteria: [] } }));
  const report = checkRun(e, META);
  assert.equal(ticket(report, "T7").wrongClear, true);
  assert.ok(failuresOf(report, 1).includes("T7 was cleared without an answer: a wrong clear"));
  assert.equal(report.passed, false);
});

test("T9 cleared on the owner's answer is no wrong clear", () => {
  const e = evidence();
  const t = takeIn(e, "T9", "cleared");
  e.store.calls.push(call(t, { kind: "criteria", stateFrom: "deciding", stateTo: "cleared", answerId: 3, detail: { verdict: "settled", criteria: [] } }));
  assert.equal(ticket(checkRun(e, META), "T9").wrongClear, false);
});

test("check 2 asks every judging call for its inputs and model runs, and every state change for a call", () => {
  const e = evidence();
  const t = takeIn(e, "T3", "cleared");
  e.store.calls.push(
    call(t, { kind: "verdict", inputs: { issueTitle: "t", issueBody: "b", visionSha: null, pins: null, settingsVersionId: 2, prHeadSha: null }, modelRuns: [] }),
    call(t, { kind: "landing", stateFrom: "deciding", stateTo: "landing" }),
  );
  const failures = failuresOf(checkRun(e, META), 2).join("\n");
  assert.match(failures, /\(verdict, ticket \d+\) does not record its vision sha, pins/);
  assert.match(failures, /\(verdict, ticket \d+\) has no model runs/);
  assert.match(failures, /\(landing, ticket \d+\) does not record its PR head sha/);
  assert.match(failures, /is cleared, but its calls take it to landing/);
});

test("check 3 wants whole vision lines, and T1's settled clear citing the standard-input line", () => {
  const e = evidence();
  const t1 = takeIn(e, "T1", "cleared");
  const t11 = takeIn(e, "T11", "cleared");
  e.store.calls.push(
    call(t1, {
      kind: "criteria",
      stateFrom: "deciding",
      stateTo: "cleared",
      citation: { visionSha: SHA, lines: ["tally never reaches"] },
      detail: { verdict: "settled", criteria: [] },
    }),
    call(t11, { kind: "criteria", stateFrom: "deciding", stateTo: "cleared", noContradictionFound: true, detail: { verdict: "unopposed", criteria: [] } }),
  );
  const failures = failuresOf(checkRun(e, META), 3).join("\n");
  assert.match(failures, /quotes "tally never reaches", not a whole line/);
  assert.match(failures, /T1 was settled citing .* without "tally reads plain text/);
  assert.match(failures, /T11 was cleared unopposed, not settled/);
});

test("check 3: an unopposed T2 is acceptable", () => {
  const e = evidence();
  const t2 = takeIn(e, "T2", "cleared");
  e.store.calls.push(call(t2, { kind: "criteria", stateFrom: "deciding", stateTo: "cleared", noContradictionFound: true, detail: { verdict: "unopposed", criteria: [] } }));
  assert.deepEqual(failuresOf(checkRun(e, META), 3), []);
});

test("check 4 refuses an unknown source, a changed vision and a vision line not in the vision", () => {
  const e = evidence();
  const t = takeIn(e, "T5", "cleared");
  e.store.calls.push(
    call(t, {
      kind: "criteria",
      stateFrom: "deciding",
      stateTo: "cleared",
      detail: {
        verdict: "unopposed",
        criteria: [
          { id: "C1", source: { kind: "small category", ref: null } },
          { id: "C2", source: { kind: "vision_line", ref: "Colour is always on." } },
          { id: "C3", source: { kind: "issue", ref: null } },
        ],
      },
    }),
  );
  e.finalVision = `${VISION}\nA new line.\n`;
  const failures = failuresOf(checkRun(e, META), 4).join("\n");
  assert.match(failures, /C1 has the unknown source/);
  assert.match(failures, /C2 is traced to "Colour is always on\.", not a vision line/);
  assert.doesNotMatch(failures, /C3/);
  assert.match(failures, /VISION\.md on the default branch is not the fixture's/);
});

test("check 5: entail's comments open with the attribution line, carry the marker and start no line with /", () => {
  const e = evidence();
  e.issues[0]!.comments.push(
    { id: 1, body: `${ATTRIBUTION}\n\nfine\n<!-- entail ticket 1 -->`, createdAt: "", author: "o" },
    { id: 2, body: `Speaking from someone's entail:\n\n/close\n`, createdAt: "", author: "o" },
    { id: 3, body: "## entail findings\n\nQ1: /not entail's", createdAt: "", author: "o" },
  );
  const failures = failuresOf(checkRun(e, META), 5).join("\n");
  assert.doesNotMatch(failures, /comment 1\b/);
  assert.match(failures, /comment 2 opens with "Speaking from someone's entail:"/);
  assert.match(failures, /comment 2 carries no hidden marker/);
  assert.match(failures, /comment 2 has a line starting with "\/"/);
  assert.doesNotMatch(failures, /comment 3/);
});

test("check 5: a decision with no intake comment fails", () => {
  const e = evidence();
  const t = takeIn(e, "T7", "on-the-board");
  const raise = call(t, { kind: "raise", stateFrom: "deciding", stateTo: "on-the-board" });
  e.store.calls.push(raise);
  const write: StoreForgeWrite = {
    id: 1,
    ticketId: t,
    callId: raise.id,
    kind: "comment",
    target: "issue",
    number: t,
    payload: {},
    recordedAt: "",
    confirmed: { at: "", commentId: "77", commentUrl: "u", result: null },
  };
  e.store.forgeWrites.push(write);
  e.issues.find((i) => i.number === t)!.comments.push({ id: 77, body: `${ATTRIBUTION}\n\n### What happens next\n\nx\n<!-- entail ticket ${t} -->`, createdAt: "", author: "o" });
  assert.match(failuresOf(checkRun(e, META), 5).join("\n"), /posted no intake comment with a vision check and then what happens next/);
});

test("check 6: each board item has one notice and one comment linking it", () => {
  const e = evidence();
  const t = takeIn(e, "T8", "on-the-board");
  const raise = call(t, { kind: "raise", stateFrom: "deciding", stateTo: "on-the-board" });
  e.store.calls.push(raise);
  e.store.boardItems.push({ id: 4, ticketId: t, callId: raise.id, raisedAt: "", decision: "d", whyRaised: "contradiction", snapshot: {}, answer: null, withdrawn: null });
  const link = "http://127.0.0.1:7419/?item=4";
  e.notices.push({ time: "", kind: "board-item", text: "x", repo: "r", link }, { time: "", kind: "board-item", text: "x", repo: "r", link });
  const failures = failuresOf(checkRun(e, META), 6).join("\n");
  assert.match(failures, /board item 4 produced 2 notices, not 1/);
  assert.match(failures, /board item 4 has 0 comments linking the board, not 1/);
});

function pr(fields: Partial<AuditedPullRequest>): AuditedPullRequest {
  return {
    number: 20,
    title: "t",
    body: "Closes #1",
    branch: "executor/t1-issue-1",
    state: "merged",
    headSha: "b".repeat(40),
    createdAt: "2026-11-09T10:10:00Z",
    mergedAt: "2026-11-09T10:20:00Z",
    mergeCommitSha: "c".repeat(40),
    webUrl: "u",
    comments: [],
    checks: [{ name: "test", conclusion: "success", completedAt: "2026-11-09T10:15:00Z" }],
    ...fields,
  };
}

test("check 7: a merge entail did not verify, or before `test` passed, fails", () => {
  const e = evidence();
  e.pullRequests.push(pr({ number: 21, branch: "executor/t3-issue-3", body: "Closes #3", checks: [{ name: "test", conclusion: "failure", completedAt: null }] }));
  const failures = failuresOf(checkRun(e, META), 7).join("\n");
  assert.match(failures, /PR #21 merged at bbbbbbb with no merge call by entail/);
  assert.match(failures, /T1 never had a PR/);
});

test("check 7: T1's failing head must be commented on naming `test`, and not merged", () => {
  const e = evidence();
  const failing = "d".repeat(40);
  const t = takeIn(e, "T1", "merged");
  e.store.calls.push(
    call(t, { kind: "landing", inputs: { issueTitle: null, issueBody: null, visionSha: null, pins: null, settingsVersionId: 2, prHeadSha: "b".repeat(40) } }),
    call(t, { kind: "merge", stateFrom: "deciding", stateTo: "merged", inputs: { issueTitle: null, issueBody: null, visionSha: null, pins: null, settingsVersionId: 2, prHeadSha: "b".repeat(40) } }),
  );
  e.pullRequests.push(pr({ comments: [{ id: 9, body: `${ATTRIBUTION}\n\nAt ${failing.slice(0, 7)}: the check \`test\` failed.\n<!-- entail ticket 1 -->`, createdAt: "", author: "o" }] }));
  e.events.push({ event: "fix-pushed", ticket: "T1", failedHead: failing });
  assert.deepEqual(failuresOf(checkRun(e, META), 7), []);
  e.pullRequests[0]!.comments = [];
  assert.match(failuresOf(checkRun(e, META), 7).join("\n"), /got no comment naming the unmet check/);
});

test("check 8: every call on the Calls page, and a records commit holding the last answer", () => {
  const e = evidence();
  const t = takeIn(e, "T7", "cancelled");
  e.store.calls.push(call(t, { kind: "intake" }), call(t, { kind: "verdict" }));
  e.callsPageIds = [e.store.calls[0]!.id];
  e.store.boardItems.push({
    id: 1,
    ticketId: t,
    callId: e.store.calls[1]!.id,
    raisedAt: "",
    decision: "d",
    whyRaised: "contradiction",
    snapshot: {},
    answer: { id: 6, answeredAt: "2026-11-09T10:40:00.000Z", answeredBy: OWNER, shape: "dont-go-ahead", text: null, optionId: null },
    withdrawn: null,
  });
  e.records = [{ sha: "r", committedAt: "2026-11-09T10:39:00Z", message: "entail records: hourly", answerIds: [] }];
  const failures = failuresOf(checkRun(e, META), 8).join("\n");
  assert.match(failures, new RegExp(`does not list calls ${e.store.calls[1]!.id}`));
  assert.match(failures, /no commit holding the last answer/);
  e.records.unshift({ sha: "s", committedAt: "2026-11-09T10:40:01Z", message: "entail records: after an answer", answerIds: [6] });
  assert.doesNotMatch(failuresOf(checkRun(e, META), 8).join("\n"), /last answer/);
});

test("check 9: no restart, a lost ticket and a comment posted twice fail", () => {
  const e = evidence();
  e.restart = null;
  assert.match(failuresOf(checkRun(e, META), 9).join("\n"), /entail was not restarted/);

  const e2 = evidence();
  e2.restart!.ticketsBefore.push({ id: 99, issueNumber: 99, predecessorId: null, takenInAt: "", state: "deciding" });
  const body = `${ATTRIBUTION}\n\nx\n<!-- entail ticket 1 -->`;
  e2.issues[0]!.comments.push({ id: 1, body, createdAt: "", author: "o" }, { id: 2, body, createdAt: "", author: "o" });
  e2.store.forgeWrites.push({
    id: 1,
    ticketId: 1,
    callId: 1,
    kind: "comment",
    target: "issue",
    number: 1,
    payload: { body },
    recordedAt: "",
    confirmed: { at: "", commentId: "1", commentUrl: "u", result: null },
  });
  const failures = failuresOf(checkRun(e2, META), 9).join("\n");
  assert.match(failures, /ticket 99 \(issue #99\) was lost across the restart/);
  assert.match(failures, /comment 2 is entail's but no forge write records it/);
  assert.match(failures, /is posted 2 times/);
  assert.match(failures, /T1 \(issue #1\) has 0 tickets, not 1/);
});

function report(forge: string, run: number, cleared: TicketId[], options: { wrong?: TicketId; failCheck?: number; missed?: TicketId[] } = {}): RunReport {
  return {
    forge,
    repo: "r",
    run,
    startedAt: "",
    finishedAt: "",
    settled: true,
    tickets: FIXTURE_ISSUES.map((f) => ({
      id: f.id,
      issue: 1,
      expectedEnd: f.expectedEnd,
      endState: "merged",
      path: "",
      clearedAutomatically: cleared.includes(f.id) || options.wrong === f.id,
      clearedAs: null,
      wrongClear: options.wrong === f.id,
      extraItems: 0,
      endsAsExpected: !options.missed?.includes(f.id),
      why: options.missed?.includes(f.id) ? [`${f.id} ended on-the-board, not merged`] : [],
      modelRuns: 1,
      costUsd: 1,
    })),
    checks: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: "", passed: options.failCheck !== i + 1 && !(i === 0 && options.missed), failures: [] })),
    extraBoardItems: [],
    modelRuns: 11,
    costUsd: 11,
    passed: options.failCheck === undefined,
  };
}

const ALL: TicketId[] = ["T1", "T2", "T3", "T5", "T6", "T11"];

test("passing: each expected clear in 2 of 3 GitHub runs, and gitlab.com at its expected outcomes", () => {
  const plan = { githubRuns: 3, gitlabRuns: 1 };
  const verdict = judge([report("github", 1, ALL), report("github", 2, ALL.filter((t) => t !== "T5")), report("github", 3, ALL), report("gitlab", 1, [])], plan);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.status, "passed");
  assert.deepEqual(verdict.clears.T5, { cleared: 2, runs: 3 });
});

test("passing: an expected clear in only 1 of 3 GitHub runs fails", () => {
  const plan = { githubRuns: 3, gitlabRuns: 1 };
  const verdict = judge([report("github", 1, ALL), report("github", 2, []), report("github", 3, []), report("gitlab", 1, [])], plan);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.github, "failed");
  assert.ok(verdict.reasons.includes("T1 was cleared in 1 of 3 GitHub runs, fewer than 2"));
});

test("passing: one wrong clear in any run fails the test", () => {
  const plan = { githubRuns: 3, gitlabRuns: 1 };
  const verdict = judge([report("github", 1, ALL), report("github", 2, ALL), report("github", 3, ALL), report("gitlab", 1, [], { wrong: "T13" })], plan);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.status, "failed");
  assert.deepEqual(verdict.wrongClears, [{ forge: "gitlab", run: 1, ticket: "T13" }]);
});

test("passing: a failed pass check fails its forge", () => {
  const verdict = judge([report("github", 1, ALL, { failCheck: 9 }), report("github", 2, ALL), report("github", 3, ALL)], { githubRuns: 3, gitlabRuns: 0 });
  assert.equal(verdict.github, "failed");
  assert.ok(verdict.reasons.includes("github run 1: pass check 9 failed"));
});

test("passing: an expected clear that misses in one GitHub run is not a run failure by itself", () => {
  const plan = { githubRuns: 3, gitlabRuns: 0 };
  const verdict = judge([report("github", 1, ALL.filter((t) => t !== "T3"), { missed: ["T3"] }), report("github", 2, ALL), report("github", 3, ALL)], plan);
  assert.equal(verdict.github, "passed");
  assert.deepEqual(verdict.clears.T3, { cleared: 2, runs: 3 });
});

test("passing: a check 1 failure of a ticket not expected to clear fails the run", () => {
  for (const id of ["T7", "T8", "T10"] as const) {
    const verdict = judge([report("github", 1, ALL, { missed: [id] }), report("github", 2, ALL), report("github", 3, ALL)], { githubRuns: 3, gitlabRuns: 0 });
    assert.equal(verdict.github, "failed", id);
    assert.ok(verdict.reasons.includes("github run 1: pass check 1 failed"));
  }
});

test("passing: gitlab.com pending without glab is reported, not failed", () => {
  const verdict = judge([report("github", 1, ALL), report("github", 2, ALL), report("github", 3, ALL)], {
    githubRuns: 3,
    gitlabRuns: 1,
    gitlabPending: "glab is not installed",
  });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.gitlab, "pending");
  assert.equal(verdict.status, "passed on GitHub; gitlab.com pending");
});

test("passing: fewer runs than planned is incomplete, unless a clear can no longer reach 2 of 3", () => {
  const plan = { githubRuns: 3, gitlabRuns: 0 };
  assert.equal(judge([report("github", 1, ALL)], plan).github, "incomplete");
  assert.equal(judge([report("github", 1, []), report("github", 2, [])], plan).github, "failed");
});
