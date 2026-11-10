import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { BoardData } from "../../src/app-view.ts";
import { BOARD_ITEM_VERSION, boardOptions, decisionSentence, whyRaised, type BoardItemSnapshot, type WhyRaisedInput } from "../../src/board-item.ts";
import { BOARD_DATA_PATH, BOARD_POLL_MS, boardPages, raisedAgo, startOfDay, whatNext, type BoardPageOptions } from "../../src/board-page.ts";
import type { VisionCheck } from "../../src/intake-comment.ts";
import { startServer, type LocalServer } from "../../src/server.ts";
import { Store, type BoardItemRecord, type RepoRecord, type TicketRecord } from "../../src/store.ts";
import { afterPoll } from "../../src/ui/board.ts";
import { decodeEntities, parsePage } from "../acceptance/html.ts";
import { send } from "../http-client.ts";
import { boardPage, getData, renderBoard, renderItem } from "./render.ts";

const VISION_SHA = "c".repeat(40);
const NETWORK = "tally never reaches the network.";
const WORD = "A word is a run of characters between whitespace.";

interface Board {
  store: Store;
  server: LocalServer;
  github: RepoRecord;
  gitlab: RepoRecord;
  /** Moves the store's clock on by this many minutes. */
  advance(minutes: number): void;
  raise(repo: RepoRecord, issueNumber: number, why: WhyRaisedInput, check?: Partial<VisionCheck>): { ticket: TicketRecord; item: BoardItemRecord };
  /** The board page as the app renders it from the server's data. */
  get(path: string): Promise<{ status: number; body: string; data: BoardData }>;
  /** The board's data as the app asks for it every few seconds. */
  live(item: number | null): Promise<BoardData>;
}

/** A board item's snapshot, as raising writes it. */
function snapshotOf(repo: RepoRecord, ticket: TicketRecord, why: WhyRaisedInput, checkParts: Partial<VisionCheck>): { decision: string; snapshot: BoardItemSnapshot } {
  const check: VisionCheck = {
    commit: VISION_SHA,
    lines: [
      {
        text: NETWORK,
        heading: "What tally is",
        lineNumber: 4,
        mark: "contradicts",
        permalink: `https://${repo.host}/${repo.path}/blob/${VISION_SHA}/VISION.md#L4`,
      },
    ],
    unquotable: [],
    ...checkParts,
  };
  const w = whyRaised(why, check);
  const decision = decisionSentence(ticket.issueNumber, w);
  return {
    decision,
    snapshot: {
      version: BOARD_ITEM_VERSION,
      decision,
      why: w,
      visionCheck: check,
      ticket: {
        repo: { forge: repo.forge, host: repo.host, path: repo.path },
        issue: { number: ticket.issueNumber, title: `Issue ${ticket.issueNumber} <title>`, url: `https://${repo.host}/${repo.path}/issues/${ticket.issueNumber}` },
        filedBy: { forge: repo.forge, host: repo.host, id: 7, username: "reporter" },
        request: `Please do <b>this</b> for issue ${ticket.issueNumber}.`,
      },
      happened: {
        calls: [
          { ticketId: ticket.id, callId: 2, kind: "verdict", madeAt: "2026-11-09T09:01:00.000Z", reason: "Needs the owner.", stateChange: { from: "deciding", to: "on-the-board" } },
          { ticketId: ticket.id, callId: 1, kind: "intake", madeAt: "2026-11-09T09:00:00.000Z", reason: "Taken in.", stateChange: null },
        ],
        answers: [],
        historyLink: `http://127.0.0.1:7419/ticket?id=${ticket.id}`,
      },
      form: {
        options: boardOptions(
          [
            { id: "R1", reading: "Any Unicode whitespace separates words", observed_outcome: "“new york” counts as 2 words." },
            { id: "R2", reading: "Only spaces, tabs and line breaks", observed_outcome: "“new york” counts as 1 word." },
          ],
          [],
          check,
        ),
      },
    },
  };
}

async function serveBoard(t: TestContext, options: Partial<BoardPageOptions> = {}, clock?: { now: number }): Promise<Board> {
  const dir = mkdtempSync(join(tmpdir(), "entail-board-"));
  const time = clock ?? { now: new Date(2026, 10, 9, 9, 0, 0).getTime() };
  const store = Store.openIn(dir, { now: () => new Date((time.now += 1000)) });
  const github = store.enrollRepo({ forge: "github", host: "github.com", projectId: 11, path: "acme/tally", ownerAccountId: 1, ownerLogin: "owner" });
  const gitlab = store.enrollRepo({ forge: "gitlab", host: "gitlab.com", projectId: 22, path: "acme/tally-gl", ownerAccountId: 2, ownerLogin: "owner" });
  store.saveGlobalSettings({ ownerDisplayName: "Ada Owner" }, "Ada Owner");

  const raise: Board["raise"] = (repo, issueNumber, why, check = {}) => {
    const ticket = store.takeIn({ repoId: repo.id, issueNumber });
    store.recordCall({ ticketId: ticket.id, kind: "intake", reason: "Taken in." });
    const call = store.recordCall({ ticketId: ticket.id, kind: "raise", reason: "Raised to the owner.", stateTo: "on-the-board" });
    const { decision, snapshot } = snapshotOf(repo, ticket, why, check);
    const item = store.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision, whyRaised: why.kind, snapshot });
    return { ticket, item };
  };
  const server = await startServer({
    port: 0,
    pages: boardPages({ store, now: () => new Date(time.now), ...options }),
  });
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
    raise,
    advance: (minutes) => void (time.now += minutes * 60_000),
    get: (path) => boardPage(server.info.port, path),
    live: (item) => getData(server.info.port, item === null ? BOARD_DATA_PATH : `${BOARD_DATA_PATH}?item=${item}`),
  };
}

/** The decisions in the list, in order, under each heading. */
function listed(html: string): { open: string[]; ended: string[] } {
  const list = html.slice(html.indexOf('<nav id="board-list"'), html.indexOf("</nav>", html.indexOf('<nav id="board-list"')));
  const [open = "", ended = ""] = list.split("Answered or withdrawn today");
  const decisions = (part: string) => [...part.matchAll(/<span class="d">([^<]*)<\/span>/g)].map((m) => decodeEntities(m[1]!));
  return { open: decisions(open), ended: decisions(ended) };
}

/** The item's state box as the app shows it, and whether its form is locked. */
function stateOf(html: string): { kind: string; locked: string; text: string } {
  const box = /<div id="item-state" class="state state-([a-z-]+)" role="status">([\s\S]*?)<\/div>/.exec(html);
  const form = /<form id="answer-form"[^>]* data-locked="([^"]*)"/.exec(html);
  return { kind: box?.[1] ?? "open", locked: form?.[1] ?? "no form", text: box ? parsePage(box[2]!).text : "" };
}

function withdraw(board: Board, ticket: TicketRecord, item: BoardItemRecord, reason: string, stateTo: "deciding" | "cancelled"): void {
  const call = board.store.recordCall({ ticketId: ticket.id, kind: stateTo === "cancelled" ? "cancel-on-outside-close" : "recheck", reason, stateTo });
  board.store.withdrawBoardItem({ boardItemId: item.id, callId: call.id, reason });
}

test("the list orders open items oldest raised first across repos, with decision, repo, forge, age and why-tag", async (t) => {
  const board = await serveBoard(t);
  const first = board.raise(board.gitlab, 3, { kind: "consequential_readings" }, { lines: [] });
  board.advance(50);
  const second = board.raise(board.github, 9, { kind: "pin", pins: [{ pin: "the output format", why: "it renames src/format.js" }] });
  board.advance(10);
  const third = board.raise(board.gitlab, 1, { kind: "contradiction" });
  board.advance(5);
  const fourth = board.raise(board.github, 2, { kind: "failed_check", check: "citation", failure: "The cited line is not in VISION.md." });
  board.advance(1);

  const page = await board.get("/");
  assert.equal(page.status, 200);
  assert.deepEqual(
    listed(page.body).open,
    [first, second, third, fourth].map((r) => r.item.decision),
    "oldest raised first, in one list across repos",
  );
  const text = parsePage(page.body).text;
  assert.match(text, /Needs you · 4/);
  assert.match(text, /Which reading of issue #3 should go ahead\?\s*gitlab\.com\/acme\/tally-gl · GitLab · raised 1 h ago\s*consequential readings/);
  assert.match(text, /github\.com\/acme\/tally · GitHub · raised 16 min ago\s*pin: the output format/);
  assert.match(text, /gitlab\.com\/acme\/tally-gl · GitLab · raised 6 min ago\s*contradicts a line/);
  assert.match(text, /github\.com\/acme\/tally · GitHub · raised 1 min ago\s*failed check/);
  assert.match(page.body, /<a href="\/\?item=1" aria-current="true">/, "the oldest open item is selected by default");
});

test("the header names the board, its open count, the Calls page and whose answers it records", async (t) => {
  const board = await serveBoard(t);
  board.raise(board.github, 1, { kind: "contradiction" });
  const page = await board.get("/");
  const parsed = parsePage(page.body);
  assert.match(parsed.text, /Board · 1 open/);
  assert.match(parsed.text, /answering as Ada Owner/);
  assert.ok(parsed.links.some((l) => l.href === "/calls" && l.text === "Calls"), "a link to the Calls page");
  assert.equal(page.data.title, "Board (1)");
  const document = await send(board.server.info.port, { path: "/" });
  assert.match(document.body, /<title>Board \(1\) · entail<\/title>/, "the document a browser loads carries the title");
});

test("the board is an app: the document loads it, and the board itself is rendered in the browser from its data", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const document = await send(board.server.info.port, { path: `/?item=${item.id}` });
  assert.equal(document.status, 200);
  assert.match(String(document.headers["content-type"]), /^text\/html/);
  assert.match(document.body, /<script type="module" src="\/ui\/app\.js"><\/script>/, "the document loads the app");
  assert.match(document.body, /<div id="app">/);
  const main = document.body.slice(document.body.indexOf("<main"), document.body.indexOf("</main>"));
  assert.ok(!main.includes(item.decision), "the server renders none of the board: the app does");
  assert.match(main, /<noscript>/, "without script the page says the board needs it");
  const boot = /<script type="application\/json" id="entail-boot">([\s\S]*?)<\/script>/.exec(document.body);
  assert.ok(boot, "the document carries the board's data for the app to start from");
  const view = JSON.parse(boot[1]!);
  assert.equal(view.kind, "board");
  assert.equal(view.data.detail.decision, item.decision);
});

test("the item view shows the six parts in the order of spec §13", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const page = await board.get(`/?item=${item.id}`);
  const parts = [...page.body.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(parts, ["decision", "why", "vision-check", "ticket", "happened", "form"]);

  const decision = /<section data-part="decision"><h2 class="decision">([^<]*)<\/h2>/.exec(page.body);
  assert.equal(decodeEntities(decision![1]!), item.decision, "the decision is the heading");
  const parsed = parsePage(page.body);
  assert.match(parsed.text, /Why it was raised\s*The issue contradicts the vision line “tally never reaches the network\.”/);
  assert.match(parsed.text, /quoted from VISION\.md at ccccccc\./);
  assert.match(parsed.text, /Contradicts\s*tally never reaches the network\./);
  assert.match(parsed.text, /filed by reporter/);
  assert.match(parsed.text, /The reporter's request, not your word:\s*Please do <b>this<\/b> for issue 7\./, "the issue is quoted, escaped, as the reporter's request");
  assert.ok(!page.body.includes("<b>this</b>"), "issue text is never markup");
  assert.ok(parsed.links.some((l) => l.href === "https://github.com/acme/tally/issues/7"), "the issue is linked");
  assert.ok(parsed.links.some((l) => l.href === `/ticket?id=${ticket.id}` && /history/.test(l.text)), "what happened links the ticket's history");
  const happened = parsed.text.slice(parsed.text.indexOf("What happened"));
  assert.ok(happened.indexOf("Needs the owner.") < happened.indexOf("Taken in."), "calls newest first");

  const form = parsed.forms.find((f) => f.controls.some((c) => c.name === "answer"))!;
  const labels = form.controls.filter((c) => c.type === "radio").map((c) => c.label);
  assert.equal(labels.length, 4);
  assert.match(
    labels[0]!,
    /^Any Unicode whitespace separates words\s*“new york” counts as 2 words\.\s*This goes against a vision line for this ticket only\. The line stays as it is; to change the rule, edit VISION\.md\.$/,
    "each option with the outcome a user would observe, and the warning when going ahead goes against a vision line",
  );
  assert.match(labels[2]!, /^Answer in my own words$/);
  assert.match(labels[3]!, /^Don't go ahead/, "then don't go ahead");
  assert.ok(form.controls.some((c) => c.type === "checkbox" && /Show my note on the issue/.test(c.label)));
  assert.match(parsed.text, /Add a note/);
  assert.equal(page.data.token, board.server.info.token, "the answer carries the per-start token");
  assert.equal(page.data.detail.kind === "item" && page.data.detail.version, BOARD_ITEM_VERSION, "and the item version it shows");
});

test("the app asks for the board every few seconds, and the live board says when the shown item is withdrawn", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const other = board.raise(board.gitlab, 8, { kind: "contradiction" });

  const page = await board.get(`/?item=${item.id}`);
  assert.ok(BOARD_POLL_MS <= 5000, "every few seconds");
  assert.equal(page.data.pollMs, BOARD_POLL_MS);

  let live = await board.live(item.id);
  let shown = renderBoard(live);
  assert.deepEqual(stateOf(shown), { kind: "open", locked: "false", text: "" });
  assert.deepEqual(listed(shown).open, [item.decision, other.item.decision]);
  assert.match(shown, /<span id="board-count" class="count">· 2 open<\/span>/);

  withdraw(board, ticket, item, "The issue was edited.", "deciding");
  live = await board.live(item.id);
  shown = renderBoard(live);
  const state = stateOf(shown);
  assert.equal(state.kind, "withdrawn");
  assert.equal(state.locked, "true");
  assert.match(state.text, /Withdrawn: this item takes no answer\.\s*The issue was edited\.\s*The ticket is decided again\. If it still needs you, a new item comes to the board\.\s*Anything you typed stays below to copy\. It is not recorded\./);
  assert.deepEqual(listed(shown), { open: [other.item.decision], ended: [item.decision] }, "it moves to answered or withdrawn today");
  assert.match(shown, /· 1 open/);

  // Cancelled by an outside close.
  withdraw(board, other.ticket, other.item, "The issue was closed on GitLab by someone else.", "cancelled");
  assert.match(stateOf(renderBoard(await board.live(other.item.id))).text, /closed on GitLab.*\s*The ticket is cancelled, so nothing more is asked\./);
});

test("a withdrawn item's form is locked: nothing in it can be sent", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  withdraw(board, ticket, item, "A vision change reworded a line in this item's vision check.", "deciding");

  const page = await board.get(`/?item=${item.id}`);
  const form = parsePage(page.body).forms.find((f) => f.controls.some((c) => c.name === "answer"))!;
  assert.ok(form.controls.filter((c) => c.type === "radio" || c.type === "checkbox").every((c) => c.disabled), "every choice is disabled");
  assert.match(page.body, /<form id="answer-form" class="answer"[^>]* data-locked="true"/);
  assert.equal((page.body.match(/<textarea [^>]*readOnly=""[^>]*>/gi) ?? []).length, 2, "text fields stay readable to copy, but read-only");
  assert.ok(form.controls.filter((c) => c.tag === "button" || c.type === "submit").every((c) => c.disabled), "no button sends it");
  assert.equal(stateOf(page.body).kind, "withdrawn");
});

test('"Answered or withdrawn today" empties at the end of the day', async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 9, 10, 0, 0) });
  const dir = mkdtempSync(join(tmpdir(), "entail-board-day-"));
  const store = Store.openIn(dir);
  const server = await startServer({ port: 0, pages: boardPages({ store }) });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = store.enrollRepo({ forge: "github", host: "github.com", projectId: 11, path: "acme/tally", ownerAccountId: 1, ownerLogin: "owner" });
  const raise = (issueNumber: number) => {
    const ticket = store.takeIn({ repoId: repo.id, issueNumber });
    const call = store.recordCall({ ticketId: ticket.id, kind: "raise", reason: "Raised.", stateTo: "on-the-board" });
    const { decision, snapshot } = snapshotOf(repo, ticket, { kind: "contradiction" }, {});
    return { ticket, item: store.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision, whyRaised: "contradiction", snapshot }) };
  };
  const answered = raise(1);
  const withdrawn = raise(2);
  const open = raise(3);
  store.recordAnswer({ boardItemId: answered.item.id, answeredBy: "Ada Owner", shape: "dont-go-ahead" });
  const recheck = store.recordCall({ ticketId: withdrawn.ticket.id, kind: "recheck", reason: "Edited.", stateTo: "deciding" });
  store.withdrawBoardItem({ boardItemId: withdrawn.item.id, callId: recheck.id, reason: "The issue was edited." });

  const board = async () => listed((await boardPage(server.info.port, "/")).body);
  t.mock.timers.setTime(new Date(2026, 10, 9, 23, 59, 59).getTime());
  assert.deepEqual(await board(), { open: [open.item.decision], ended: [answered.item.decision, withdrawn.item.decision] });

  t.mock.timers.setTime(new Date(2026, 10, 10, 0, 0, 0).getTime());
  assert.deepEqual(await board(), { open: [open.item.decision], ended: [] }, "they leave the board at the end of the day");

  const left = await boardPage(server.info.port, `/?item=${answered.item.id}`);
  assert.match(parsePage(left.body).text, /This item has left the board: it was answered before today\. Its ticket's history keeps it/);
  assert.equal((await boardPage(server.info.port, "/?item=999")).status, 404);
  assert.equal((await send(server.info.port, { path: "/?item=999" })).status, 404, "the document a browser loads says so too");
});

test("startOfDay is local midnight and raisedAgo reads in minutes, hours and days", () => {
  const start = startOfDay(new Date(2026, 10, 9, 15, 30));
  assert.deepEqual([start.getHours(), start.getMinutes(), start.getDate()], [0, 0, 9]);
  const now = new Date("2026-11-09T12:00:00.000Z");
  assert.equal(raisedAgo("2026-11-09T11:59:30.000Z", now), "raised just now");
  assert.equal(raisedAgo("2026-11-09T11:15:00.000Z", now), "raised 45 min ago");
  assert.equal(raisedAgo("2026-11-09T09:00:00.000Z", now), "raised 3 h ago");
  assert.equal(raisedAgo("2026-11-08T12:00:00.000Z", now), "raised 1 day ago");
  assert.equal(raisedAgo("2026-11-06T12:00:00.000Z", now), "raised 3 days ago");
  assert.equal(whatNext("cancelled"), "The ticket is cancelled, so nothing more is asked.");
  assert.equal(whatNext(null), null);
});

test("a paused repo's items and a halted host's items render locked, and unlock when that clears", async (t) => {
  const halted = new Set<string>(["gitlab.com"]);
  const board = await serveBoard(t, { hostHalted: (host) => halted.has(host) });
  const paused = board.raise(board.github, 1, { kind: "contradiction" });
  const unreachable = board.raise(board.gitlab, 2, { kind: "contradiction" });
  board.store.saveSettings(board.github.id, { paused: true }, "Ada Owner");

  const pausedPage = await board.get(`/?item=${paused.item.id}`);
  assert.deepEqual(stateOf(pausedPage.body), {
    kind: "paused",
    locked: "true",
    text: "This item is locked: this repo is paused.\nIts form unlocks once the repo is resumed and entail has caught up with it.",
  });
  const form = parsePage(pausedPage.body).forms.find((f) => f.controls.some((c) => c.name === "answer"))!;
  assert.ok(form.controls.filter((c) => c.type === "radio").every((c) => c.disabled));
  assert.deepEqual(listed(pausedPage.body).open, [paused.item.decision, unreachable.item.decision], "a paused repo's items stay listed");
  assert.match(pausedPage.body, /<span class="tag status">locked<\/span>/);

  const haltedState = stateOf((await board.get(`/?item=${unreachable.item.id}`)).body);
  assert.equal(haltedState.kind, "halted");
  assert.match(haltedState.text, /^This item is locked: entail cannot reach gitlab\.com\./);

  board.store.saveSettings(board.github.id, { paused: false }, "Ada Owner");
  halted.clear();
  assert.equal(stateOf(renderBoard(afterPoll(pausedPage.data, await board.live(paused.item.id)).data)).kind, "open");
  assert.equal(stateOf(renderBoard(await board.live(unreachable.item.id))).locked, "false");
});

test("a resumed repo's items stay locked while entail catches up with it, then unlock", async (t) => {
  const catching = new Set<number>();
  const board = await serveBoard(t, { catchingUp: (repoId) => catching.has(repoId) });
  const raised = board.raise(board.github, 1, { kind: "contradiction" });
  catching.add(board.github.id);
  const page = await board.get(`/?item=${raised.item.id}`);
  assert.deepEqual(stateOf(page.body), {
    kind: "catching-up",
    locked: "true",
    text: "This item is locked: entail is catching up with this repo after its pause.\nIts form unlocks once entail has handled what changed during the pause. If that changed this item's basis, it is withdrawn instead.",
  });
  assert.match(page.body, /<span class="tag status">locked<\/span>/);
  catching.clear();
  assert.equal(stateOf(renderBoard(await board.live(raised.item.id))).kind, "open");
});

test("the board offers no reordering, postponing, later, pause or split", async (t) => {
  const board = await serveBoard(t);
  board.raise(board.github, 1, { kind: "contradiction" });
  const answered = board.raise(board.gitlab, 2, { kind: "pin", pins: [{ pin: "the output format", why: "x" }] });
  board.store.recordAnswer({ boardItemId: answered.item.id, answeredBy: "Ada Owner", shape: "option", optionId: "R1" });
  for (const path of ["/", `/?item=${answered.item.id}`]) {
    const page = await board.get(path);
    const parsed = parsePage(page.body);
    const offered = [
      ...parsed.links.map((l) => l.text),
      ...parsed.forms.flatMap((f) => f.controls.map((c) => `${c.name} ${c.value} ${c.label}`)),
    ];
    const forbidden = /reorder|postpone|later|snooze|pause|split|move (up|down)|skip|priority/i;
    assert.deepEqual(offered.filter((o) => forbidden.test(o)), [], `nothing on ${path} offers work management`);
    assert.doesNotMatch(page.body, /draggable/);
  }
  const page = await board.get(`/?item=${answered.item.id}`);
  assert.match(stateOf(page.body).text, /^Answered by Ada Owner at .* · item version 1\s*The answer: Any Unicode whitespace separates words\s/);
  assert.match(stateOf(page.body).text, /Next decision$/);
});

test("the board refreshes without a reload, and a withdrawn item's form locks with its typed text kept", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  let shown = (await board.get(`/?item=${item.id}`)).data;
  const draft = { answer: "own-words", text: "Only ASCII whitespace, please.", note: "My private note.", showNote: true };

  shown = afterPoll(shown, await board.live(item.id)).data;
  assert.equal(stateOf(renderItem(shown, { draft })).locked, "false");

  // A newer item arrives on another repo: the list and count refresh in place.
  board.advance(1);
  const newer = board.raise(board.gitlab, 8, { kind: "contradiction" });
  const polled = afterPoll(shown, await board.live(item.id));
  assert.equal(polled.show, null, "the board does not move to another item");
  shown = polled.data;
  assert.deepEqual(listed(renderBoard(shown)).open, [item.decision, newer.item.decision]);
  assert.match(renderBoard(shown), /· 2 open/);
  assert.equal(shown.title, "Board (2)");
  const open = parsePage(renderItem(shown, { draft })).forms[0]!;
  assert.ok(!open.controls.some((c) => c.disabled), "the open item's form stays as it was");

  withdraw(board, ticket, item, "The issue was edited.", "deciding");
  shown = afterPoll(shown, await board.live(item.id)).data;
  const html = renderItem(shown, { draft });
  const state = stateOf(html);
  assert.equal(state.kind, "withdrawn");
  assert.match(state.text, /The issue was edited\./);
  assert.equal(state.locked, "true");
  const locked = parsePage(html).forms[0]!;
  assert.deepEqual(
    locked.controls.map((c) => [c.name, c.disabled]),
    [
      ["answer", true],
      ["answer", true],
      ["answer", true],
      ["text", false],
      ["answer", true],
      ["note", false],
      ["show_note", true],
      ["step", true],
    ],
    "choices and the button are disabled; text fields stay to copy",
  );
  assert.equal((html.match(/<textarea [^>]*readOnly=""[^>]*>/gi) ?? []).length, 2, "text fields are read-only");
  assert.equal(locked.controls.find((c) => c.name === "text")?.value, "Only ASCII whitespace, please.", "typed text stays visible to copy");
  assert.equal(locked.controls.find((c) => c.name === "note")?.value, "My private note.");
  assert.deepEqual(listed(renderBoard(shown)), { open: [newer.item.decision], ended: [item.decision] });
});

test("the shown item keeps the version it showed while the board refreshes, and says when it has left the board", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const shown = (await board.get(`/?item=${item.id}`)).data;
  const read = await board.live(item.id);
  assert.deepEqual(afterPoll(shown, read).data.detail, shown.detail, "nothing changed, so the item shows as it was");

  const gone: BoardData = { ...read, detail: { kind: "unknown" } };
  const after = afterPoll(shown, gone).data;
  assert.equal(after.detail.kind, "item", "the item stays to read");
  assert.match(stateOf(renderBoard(after)).text, /This item has left the board\./);
  assert.equal(stateOf(renderBoard(after)).locked, "true");
});

const nextLinkTo = (html: string) => /<a class="next-decision" href="([^"]*)">Next decision<\/a>/.exec(html)?.[1];

test("an empty board shows the oldest item once one is raised", async (t) => {
  const board = await serveBoard(t);
  const empty = (await board.get("/")).data;
  assert.equal(empty.detail.kind, "empty");
  assert.match(renderBoard(empty), /Nothing needs you\./);
  assert.deepEqual(afterPoll(empty, await board.live(null)).show, null, "nothing to show yet");

  const first = board.raise(board.github, 7, { kind: "contradiction" });
  board.advance(1);
  board.raise(board.gitlab, 8, { kind: "contradiction" });
  const polled = afterPoll(empty, await board.live(null));
  assert.equal(polled.show, first.item.id, "the oldest open item is opened");
  assert.match(renderBoard(polled.data), new RegExp(first.item.decision.slice(0, 20)));
});

test("a withdrawn or answered item offers Next decision to the oldest open item, and the board never moves on by itself", async (t) => {
  const board = await serveBoard(t);
  const a = board.raise(board.github, 7, { kind: "contradiction" });
  board.advance(1);
  const b = board.raise(board.gitlab, 8, { kind: "contradiction" });
  board.advance(1);
  const c = board.raise(board.github, 9, { kind: "contradiction" });

  const open = await board.get(`/?item=${a.item.id}`);
  assert.equal(nextLinkTo(open.body), undefined, "an open item has no Next decision");

  withdraw(board, a.ticket, a.item, "The issue was edited.", "deciding");
  const polled = afterPoll(open.data, await board.live(a.item.id));
  assert.equal(polled.show, null, "it does not move on by itself");
  assert.equal(nextLinkTo(renderBoard(polled.data)), `/?item=${b.item.id}`);
  assert.equal(nextLinkTo((await board.get(`/?item=${a.item.id}`)).body), `/?item=${b.item.id}`, "a fresh load carries it too");

  board.store.recordAnswer({ boardItemId: b.item.id, answeredBy: "Ada Owner", shape: "dont-go-ahead" });
  const answered = await board.get(`/?item=${b.item.id}`);
  assert.equal(nextLinkTo(answered.body), `/?item=${c.item.id}`, "answered elsewhere: Next decision opens the oldest still open");

  withdraw(board, c.ticket, c.item, "The issue was closed.", "cancelled");
  assert.equal(nextLinkTo((await board.get(`/?item=${c.item.id}`)).body), undefined, "nothing else is open");
  assert.equal(nextLinkTo(renderBoard(await board.live(c.item.id))), undefined);
});
