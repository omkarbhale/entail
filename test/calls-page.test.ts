import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CALLS_PATH, callsPages, MODEL_RUN_PATH, parseCallFilter, TICKET_PATH, ticketPath } from "../src/calls-page.ts";
import type { RetryState } from "../src/model-runs.ts";
import { startServer, type LocalServer } from "../src/server.ts";
import { Store, type CallRecord, type Citation, type NewModelRun, type RepoRecord, type TicketRecord } from "../src/store.ts";
import { ticketPage } from "../src/ticket-page.ts";
import { decodeEntities, parsePage } from "./acceptance/html.ts";
import { postForm, send } from "./http-client.ts";

const VISION_SHA = "a".repeat(40);

function run(purpose: string, input: string, output: string): NewModelRun {
  return {
    purpose,
    model: "claude-opus-5-5",
    promptVersion: `${purpose}-1`,
    sessionId: `session-${purpose}`,
    input,
    output,
    startedAt: "2026-11-01T09:00:00.000Z",
    durationMs: 12_300,
    estimatedCostUsd: 0.042,
  };
}

interface Records {
  store: Store;
  server: LocalServer;
  github: RepoRecord;
  gitlab: RepoRecord;
  /** Every call recorded, in the order made. */
  calls: CallRecord[];
  /** On GitHub issue 5: a verdict put it on the board, the owner answered, criteria cleared it, a landing check ran. */
  answered: TicketRecord;
  /** On GitHub issue 6: cancelled, then pulled in again as {@link pulledInAgain}. */
  cancelled: TicketRecord;
  pulledInAgain: TicketRecord;
  /** On GitLab issue 2: put on the board, then withdrawn by an issue edit. */
  withdrawn: TicketRecord;
}

/**
 * A store with calls across two repos and three days, served with the Calls
 * page and ticket pages. Each record's time is the clock's, which moves on a
 * minute per record and to a new day where a test needs one.
 */
async function serveRecords(t: TestContext, retryState: (ticketId: number) => RetryState | null = () => null): Promise<Records> {
  const dir = mkdtempSync(join(tmpdir(), "entail-calls-"));
  let clock = Date.UTC(2026, 10, 1, 9, 0, 0);
  const store = Store.openIn(dir, { now: () => new Date((clock += 60_000)) });
  const nextDay = () => (clock = Math.floor(clock / 86_400_000 + 1) * 86_400_000 + 9 * 3_600_000);
  const github = store.enrollRepo({ forge: "github", host: "github.com", projectId: 11, path: "acme/tally", ownerAccountId: 1, ownerLogin: "owner" });
  const gitlab = store.enrollRepo({ forge: "gitlab", host: "gitlab.com", projectId: 22, path: "acme/tally-gl", ownerAccountId: 2, ownerLogin: "owner" });
  const settings = store.saveSettings(github.id, { shadow: false }, "Ada Owner");
  const calls: CallRecord[] = [];
  const call = (c: Parameters<Store["recordCall"]>[0]) => {
    const recorded = store.recordCall(c);
    calls.push(recorded);
    return recorded;
  };

  // Day 1: issue 5 on GitHub is taken in and put on the board.
  const answered = store.takeIn({ repoId: github.id, issueNumber: 5 });
  call({ ticketId: answered.id, kind: "intake", reason: "The owner filed the issue.", inputs: { issueTitle: "Count NBSP", issueBody: "Counts differ <b>here</b>." } });
  const toBoard = call({
    ticketId: answered.id,
    kind: "verdict",
    reason: "Two readings lead to different outcomes.",
    inputs: { issueTitle: "Count NBSP", issueBody: "Counts differ <b>here</b>.", visionSha: VISION_SHA, pins: [{ topic: "VISION.md" }], settingsVersionId: settings.id },
    detail: { verdict: "needs_the_owner", vision_sha: VISION_SHA, citations: [{ lines: ["A word is a run of characters between whitespace."], reading: "R1" }] },
    checks: [{ check: "citation", result: "passed" }],
    challenge: { objection: null, upheld: true },
    stateTo: "on-the-board",
    modelRuns: [run("verdict", "THE VERDICT PROMPT <with markup>", '{"verdict":"needs_the_owner"}'), run("challenge", "THE CHALLENGE PROMPT", "not json")],
  });
  const item = store.raiseBoardItem({
    ticketId: answered.id,
    callId: toBoard.id,
    decision: "Should a non-breaking space separate words?",
    whyRaised: "consequential readings",
    snapshot: { options: [] },
  });

  // Day 2: the owner answers; criteria cite the answer; issue 6 is cancelled and pulled in again.
  nextDay();
  const answer = store.recordAnswer({
    boardItemId: item.id,
    answeredBy: "Ada Owner",
    shape: "own-words",
    text: "Any Unicode whitespace separates words.",
    note: "Matches wc.",
  });
  call({
    ticketId: answered.id,
    kind: "criteria",
    reason: "Criteria written from the answer.",
    answerId: answer.id,
    // Recorded as spec §4 has it: each line with its heading and line number.
    citation: {
      commit: VISION_SHA,
      lines: [{ heading: "Counting", text: "A word is a run of characters between whitespace.", lineNumber: 4 }],
    } as unknown as Citation,
    stateTo: "deciding",
  });
  call({ ticketId: answered.id, kind: "criteria", reason: "Cleared with criteria C1.", answerId: answer.id, stateTo: "cleared" });
  const cancelled = store.takeIn({ repoId: github.id, issueNumber: 6 });
  call({ ticketId: cancelled.id, kind: "cancel-on-outside-close", reason: "The issue was closed on the forge.", stateTo: "cancelled" });
  const pulledInAgain = store.takeIn({ repoId: github.id, issueNumber: 6, predecessorId: cancelled.id });
  call({ ticketId: pulledInAgain.id, kind: "intake", reason: "Pulled in again with /entail." });

  // Day 3: a landing check on the answered ticket's PR, a shadow "would merge", and a withdrawn item on GitLab.
  nextDay();
  const landing = call({
    ticketId: answered.id,
    kind: "landing",
    reason: "Every criterion is met.",
    inputs: { prHeadSha: "b".repeat(40) },
    stateTo: "landing",
  });
  const intent = store.recordForgeWriteIntent({ repoId: github.id, ticketId: answered.id, callId: landing.id, kind: "comment", target: "pr", number: 17, payload: { body: "x" } });
  store.confirmForgeWrite({ intentId: intent.id, comment: { id: "c-1", url: "https://github.com/acme/tally/pull/17#issuecomment-1" } });
  call({ ticketId: answered.id, kind: "would-merge", reason: "Shadow: entail would merge PR #17." });
  const withdrawn = store.takeIn({ repoId: gitlab.id, issueNumber: 2 });
  const pinned = call({ ticketId: withdrawn.id, kind: "verdict", reason: "Touches the output format pin.", stateTo: "on-the-board" });
  const pinItem = store.raiseBoardItem({ ticketId: withdrawn.id, callId: pinned.id, decision: "Change the output format?", whyRaised: "pin", snapshot: {} });
  const recheck = call({ ticketId: withdrawn.id, kind: "recheck", reason: "The issue was edited.", stateTo: "deciding" });
  store.withdrawBoardItem({ boardItemId: pinItem.id, callId: recheck.id, reason: "the issue was edited" });

  const server = await startServer({ port: 0, pages: [...callsPages(store), ticketPage({ store, retryState })] });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    server,
    github,
    gitlab,
    calls,
    answered: store.getTicket(answered.id)!,
    cancelled: store.getTicket(cancelled.id)!,
    pulledInAgain: store.getTicket(pulledInAgain.id)!,
    withdrawn: store.getTicket(withdrawn.id)!,
  };
}

async function get(records: Records, path: string) {
  return send(records.server.info.port, { path });
}

/** The call ids a Calls page lists, in order. */
function listedCalls(html: string): number[] {
  return [...html.matchAll(/<article class="call" id="call-(\d+)">/g)].map((m) => Number(m[1]));
}

const newestFirst = (calls: readonly CallRecord[]) => calls.map((c) => c.id).sort((a, b) => b - a);

test("every recorded call appears on the Calls page, newest first", async (t) => {
  const records = await serveRecords(t);
  const page = await get(records, CALLS_PATH);
  assert.equal(page.status, 200);
  assert.deepEqual(listedCalls(page.body), newestFirst(records.calls));
  assert.match(page.body, new RegExp(`<strong>${records.calls.length} calls</strong>`));
  for (const call of records.calls) assert.ok(page.body.includes(call.reason), `call ${call.id} shows its reason`);
  assert.match(page.body, /<a href="\/calls" aria-current="page">Calls<\/a>/, "the Calls page is in the shared header");
});

test("the filters by repo, ticket, kind and date each narrow the list, and combine", async (t) => {
  const records = await serveRecords(t);
  const { calls, github, gitlab, answered } = records;
  const ids = (keep: (c: CallRecord) => boolean) => newestFirst(calls.filter(keep));
  const day = (c: CallRecord) => c.madeAt.slice(0, 10);
  const days = [...new Set(calls.map(day))];
  assert.equal(days.length, 3, "the records span three days");

  const cases: [string, number[]][] = [
    [`repo=${gitlab.id}`, ids((c) => c.repoId === gitlab.id)],
    [`ticket=${answered.id}`, ids((c) => c.ticketId === answered.id)],
    ["kind=criteria", ids((c) => c.kind === "criteria")],
    ["kind=would-merge", ids((c) => c.kind === "would-merge")],
    [`from=${days[1]}&to=${days[1]}`, ids((c) => day(c) === days[1])],
    [`from=${days[1]}`, ids((c) => day(c) >= days[1]!)],
    [`to=${days[0]}`, ids((c) => day(c) === days[0])],
    [`repo=${github.id}&kind=intake`, ids((c) => c.repoId === github.id && c.kind === "intake")],
    [`repo=${github.id}&kind=verdict&from=${days[0]}&to=${days[0]}`, ids((c) => c.repoId === github.id && c.kind === "verdict" && day(c) === days[0])],
    [`ticket=${answered.id}&from=${days[2]}&to=${days[2]}`, ids((c) => c.ticketId === answered.id && day(c) === days[2])],
    [`repo=${gitlab.id}&kind=criteria`, []],
  ];
  for (const [query, expected] of cases) {
    const page = await get(records, `${CALLS_PATH}?${query}`);
    assert.equal(page.status, 200, query);
    assert.deepEqual(listedCalls(page.body), expected, query);
    if (expected.length === 0) assert.match(page.body, /No call matches these filters/);
  }

  // Each filter link changes its own part and keeps the others.
  const page = parsePage((await get(records, `${CALLS_PATH}?repo=${github.id}&kind=criteria`)).body);
  const hrefs = page.links.map((l) => l.href);
  assert.ok(hrefs.includes(`/calls?repo=${github.id}&kind=verdict`), "a kind link keeps the repo");
  assert.ok(hrefs.includes(`/calls?repo=${gitlab.id}&kind=criteria`), "a repo link keeps the kind");
  assert.ok(hrefs.includes(`/calls?kind=criteria`), "'any' repo drops only the repo");
  assert.ok(hrefs.includes(`/calls?repo=${github.id}&kind=criteria&from=${days[1]}&to=${days[1]}`), "a day link keeps both");
  assert.ok(hrefs.includes(`/calls?repo=${github.id}&ticket=${answered.id}&kind=criteria`), "a call's ticket link filters to its ticket");
  assert.ok(!hrefs.some((h) => h.includes(`from=${days[2]}`)), "only days with calls under the other filters are offered");
});

test("a filter that is not one is refused, and a kind with no calls lists none", async (t) => {
  const records = await serveRecords(t);
  for (const query of ["repo=x", "ticket=0", "ticket=1.5", "from=2026-13-01", "to=yesterday"]) {
    const page = await get(records, `${CALLS_PATH}?${query}`);
    assert.equal(page.status, 400, query);
  }
  assert.deepEqual(parseCallFilter(new URLSearchParams("repo=&kind=")), { ok: true, filter: {} }, "empty values filter nothing");
  const page = await get(records, `${CALLS_PATH}?kind=no-such-kind`);
  assert.equal(page.status, 200);
  assert.deepEqual(listedCalls(page.body), []);
});

test("each call shows its reason, citation permalinks, checks, challenge, issue and PR links", async (t) => {
  const records = await serveRecords(t);
  const html = (await get(records, CALLS_PATH)).body;
  const callHtml = (id: number) => html.slice(html.indexOf(`id="call-${id}"`), html.indexOf("</article>", html.indexOf(`id="call-${id}"`)));
  const [, verdict, criteria, , , , landing] = records.calls;

  const verdictHtml = callHtml(verdict!.id);
  assert.match(verdictHtml, /Two readings lead to different outcomes\./);
  assert.ok(
    verdictHtml.includes(`<a href="https://github.com/acme/tally/blob/${VISION_SHA}/VISION.md">“A word is a run of characters between whitespace.”</a>`),
    "a verdict's cited passage links VISION.md at the vision sha",
  );
  assert.match(decodeEntities(verdictHtml), /"check": "citation"/, "the mechanical check results");
  assert.match(decodeEntities(verdictHtml), /"upheld": true/, "the challenge result");
  assert.ok(verdictHtml.includes(`<a href="https://github.com/acme/tally/issues/5">issue #5</a>`));
  assert.match(decodeEntities(verdictHtml), /Counts differ <b>here<\/b>\./, "the inputs it judged, exactly as read");
  assert.doesNotMatch(verdictHtml, /<b>here<\/b>/, "issue text is escaped");

  const criteriaHtml = callHtml(criteria!.id);
  assert.ok(
    criteriaHtml.includes(`<a href="https://github.com/acme/tally/blob/${VISION_SHA}/VISION.md#L4">“A word is a run of characters between whitespace.”</a> <span class="muted">under Counting</span>`),
    "a recorded citation's line links its permalink at the line",
  );
  assert.match(decodeEntities(criteriaHtml), /Cites the answer “Any Unicode whitespace separates words\.”, given by Ada Owner/);

  const landingHtml = callHtml(landing!.id);
  assert.ok(landingHtml.includes(`<a href="https://github.com/acme/tally/pull/17">PR #17</a>`), "the PR the call wrote to");
  assert.ok(landingHtml.includes(`<a href="https://github.com/acme/tally/pull/17#issuecomment-1">the comment it posted</a>`));
  assert.match(landingHtml, /cleared → landing/);

  const gitlabHtml = callHtml(records.calls.at(-2)!.id);
  assert.ok(gitlabHtml.includes(`<a href="https://gitlab.com/acme/tally-gl/-/issues/2">issue #2</a>`), "a GitLab issue link");
  assert.match(callHtml(records.calls.at(-3)!.id), /would merge \(shadow\)/);
});

test("a call's model input and output are one click away", async (t) => {
  const records = await serveRecords(t);
  const verdict = records.calls[1]!;
  const page = parsePage((await get(records, CALLS_PATH)).body);
  const links = page.links.filter((l) => l.href.startsWith(`${MODEL_RUN_PATH}?`));
  assert.equal(links.length, records.calls.reduce((n, c) => n + c.modelRuns.length, 0), "every model run is linked");

  const [verdictRun, challengeRun] = verdict.modelRuns;
  const link = links.find((l) => l.href === `${MODEL_RUN_PATH}?id=${verdictRun!.id}`);
  assert.ok(link, "the verdict run is linked from its call");
  const runPage = await get(records, link.href);
  assert.equal(runPage.status, 200);
  const text = decodeEntities(runPage.body);
  assert.ok(text.includes("THE VERDICT PROMPT <with markup>"), "the full input");
  assert.ok(text.includes('"verdict": "needs_the_owner"'), "the output, indented");
  assert.match(text, /claude-opus-5-5/);
  assert.match(text, /verdict-1/);
  assert.match(text, /session-verdict/);
  assert.match(runPage.body, new RegExp(`href="/calls\\?ticket=${verdict.ticketId}#call-${verdict.id}"`), "back to its call");

  const challenge = decodeEntities((await get(records, `${MODEL_RUN_PATH}?id=${challengeRun!.id}`)).body);
  assert.ok(challenge.includes("not json"), "an output that is not JSON is shown as recorded");

  assert.equal((await get(records, `${MODEL_RUN_PATH}?id=999`)).status, 404);
  assert.equal((await get(records, `${MODEL_RUN_PATH}?id=abc`)).status, 404);
});

test("a ticket page shows its whole history, answers by name, and links its predecessor", async (t) => {
  const records = await serveRecords(t);
  const { answered, cancelled, pulledInAgain, withdrawn } = records;

  const page = await get(records, ticketPath(answered.id));
  assert.equal(page.status, 200);
  const html = page.body;
  const text = parsePage(html).text;
  for (const call of records.calls.filter((c) => c.ticketId === answered.id)) {
    assert.ok(html.includes(`id="call-${call.id}"`), `call ${call.id} is in the history`);
  }
  assert.doesNotMatch(html, new RegExp(`id="call-${records.calls.at(-1)!.id}"`), "only the ticket's own calls");
  assert.match(text, /Raised to the board: Should a non-breaking space separate words\?/);
  assert.match(text, /Answered by Ada Owner: “Any Unicode whitespace separates words\.”/);
  assert.match(text, /Note \(private\): Matches wc\./);
  assert.match(text, /State\s*landing/);
  assert.ok(html.includes(`<a href="https://github.com/acme/tally/issues/5">#5</a>`));

  // History is in order: taken in, the verdict, the item it raised, the answer, then what followed.
  const order = ["Taken in, deciding", "Call 2: verdict", "Raised to the board", "Answered by Ada Owner", "Call 3: criteria", "Call 7: landing check"];
  const at = order.map((s) => text.indexOf(s));
  assert.ok(at.every((i) => i >= 0), `every entry appears: ${at.join(", ")}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in the order they happened");

  const again = parsePage((await get(records, ticketPath(pulledInAgain.id))).body).text;
  assert.match(again, new RegExp(`Pulled in again after\\s*ticket ${cancelled.id}`));
  const before = (await get(records, ticketPath(cancelled.id))).body;
  assert.ok(before.includes(`<a href="${ticketPath(pulledInAgain.id)}">ticket ${pulledInAgain.id}</a>`), "the old ticket links the new one");

  const gl = parsePage((await get(records, ticketPath(withdrawn.id))).body).text;
  assert.match(gl, /Board item withdrawn: Change the output format\?/);
  assert.match(gl, /Why: the issue was edited/);

  assert.equal((await get(records, `${TICKET_PATH}?id=999`)).status, 404);
});

test("a ticket page shows its own retry state", async (t) => {
  let failing: RetryState | null = null;
  const asked: number[] = [];
  const records = await serveRecords(t, (ticketId) => {
    asked.push(ticketId);
    return failing && Number(failing.ticket) === ticketId ? failing : null;
  });
  const path = ticketPath(records.withdrawn.id);
  assert.match((await get(records, path)).body, /No model step for this ticket is failing\./);
  assert.deepEqual(asked, [records.withdrawn.id]);

  failing = {
    ticket: String(records.withdrawn.id),
    failures: 3,
    failingSince: "2026-11-03T09:00:00.000Z",
    lastFailure: { kind: "timeout", message: "the run passed 10 minutes" },
    retryAt: "2026-11-03T09:07:00.000Z",
  };
  const text = parsePage((await get(records, path)).body).text;
  assert.match(text, /This ticket's model step is failing: 3 machine failures in a row since 2026-11-03 09:00 UTC\. It is tried again at 2026-11-03 09:07 UTC\./);
  assert.match(text, /Last failure \(timeout\): the run passed 10 minutes/);
  assert.match((await get(records, ticketPath(records.answered.id))).body, /No model step for this ticket is failing\./, "another ticket's failure is not shown");
});

test("neither page has any form or action", async (t) => {
  const records = await serveRecords(t);
  const paths = [
    CALLS_PATH,
    `${CALLS_PATH}?repo=${records.github.id}&kind=verdict`,
    `${MODEL_RUN_PATH}?id=${records.calls[1]!.modelRuns[0]!.id}`,
    ticketPath(records.answered.id),
    ticketPath(records.withdrawn.id),
  ];
  for (const path of paths) {
    const page = await get(records, path);
    assert.equal(page.status, 200, path);
    assert.equal(parsePage(page.body).forms.length, 0, `${path} has no form`);
    assert.doesNotMatch(page.body, /<(form|button|input|select|textarea)\b/i, `${path} has no control`);
    assert.doesNotMatch(page.body, /<script\b/i, `${path} has no script`);
    const base = path.split("?")[0]!;
    const posted = await postForm(records.server.info.port, base, { token: records.server.info.token });
    assert.equal(posted.status, 405, `${base} takes no write`);
  }
});
