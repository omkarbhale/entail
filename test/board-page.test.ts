import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BOARD_ITEM_VERSION, boardOptions, decisionSentence, whyRaised, type BoardItemSnapshot, type WhyRaisedInput } from "../src/board-item.ts";
import { BOARD_LIVE_PATH, BOARD_POLL_MS, BOARD_SCRIPT, boardPages, raisedAgo, startOfDay, whatNext, type BoardPageOptions } from "../src/board-page.ts";
import type { VisionCheck } from "../src/intake-comment.ts";
import { startServer, type LocalServer } from "../src/server.ts";
import { Store, type BoardItemRecord, type RepoRecord, type TicketRecord } from "../src/store.ts";
import { decodeEntities, parsePage } from "./acceptance/html.ts";
import { send } from "./http-client.ts";

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
  get(path: string): Promise<{ status: number; body: string }>;
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
    get: async (path) => {
      const r = await send(server.info.port, { path });
      return { status: r.status, body: r.body };
    },
  };
}

/** The decisions in the list, in order, under each heading. */
function listed(html: string): { open: string[]; ended: string[] } {
  const list = html.slice(html.indexOf('<nav id="board-list"'), html.indexOf("</nav>", html.indexOf('<nav id="board-list"')));
  const [open = "", ended = ""] = list.split("Answered or withdrawn today");
  const decisions = (part: string) => [...part.matchAll(/<span class="d">([^<]*)<\/span>/g)].map((m) => decodeEntities(m[1]!));
  return { open: decisions(open), ended: decisions(ended) };
}

function stateOf(html: string): { key: string; locked: string; text: string } {
  const m = /<div id="item-state"[^>]*data-key="([^"]*)" data-locked="([^"]*)"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(m, "the item's state is on the page");
  return { key: m[1]!, locked: m[2]!, text: parsePage(m[3]!).text };
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
  assert.match(page.body, /<title>Board \(1\) · entail<\/title>/);
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
  assert.match(labels[0]!, /^Any Unicode whitespace separates words “new york” counts as 2 words\.$/, "each option with the outcome a user would observe");
  assert.match(labels[2]!, /^Answer in my own words$/);
  assert.match(labels[3]!, /^Don't go ahead/, "then don't go ahead");
  assert.ok(form.controls.some((c) => c.type === "checkbox" && /Show my note on the issue/.test(c.label)));
  assert.match(parsed.text, /Add a note/);
  assert.deepEqual(
    form.controls.filter((c) => c.type === "hidden").map((c) => [c.name, c.value]),
    [["item", String(item.id)], ["version", String(BOARD_ITEM_VERSION)]],
    "the form carries the item version it shows",
  );
});

test("the page asks for the board every few seconds, and the live board says when the shown item is withdrawn", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const other = board.raise(board.gitlab, 8, { kind: "contradiction" });

  const page = await board.get(`/?item=${item.id}`);
  assert.ok(BOARD_POLL_MS <= 5000, "every few seconds");
  assert.match(page.body, new RegExp(`data-live="${BOARD_LIVE_PATH.replaceAll("/", "\\/")}\\?item=${item.id}" data-poll-ms="${BOARD_POLL_MS}"`));
  assert.match(page.body, /setInterval\(poll/);
  assert.match(page.body, /el\.readOnly = locked/, "a locked form keeps typed text in place, read-only");
  assert.doesNotMatch(page.body, /location\.reload|answer-form"\)\.replaceWith|innerHTML/, "the page never reloads or replaces the form");

  let live = await board.get(`${BOARD_LIVE_PATH}?item=${item.id}`);
  assert.equal(live.status, 200);
  assert.deepEqual(stateOf(live.body), { key: "open", locked: "false", text: "" });
  assert.deepEqual(listed(live.body).open, [item.decision, other.item.decision]);
  assert.match(live.body, /<span id="board-count" class="count">· 2 open<\/span>/);

  withdraw(board, ticket, item, "The issue was edited.", "deciding");
  live = await board.get(`${BOARD_LIVE_PATH}?item=${item.id}`);
  const state = stateOf(live.body);
  assert.equal(state.key, `withdrawn:${other.item.id}`);
  assert.equal(state.locked, "true");
  assert.match(state.text, /Withdrawn: this item takes no answer\.\s*The issue was edited\.\s*The ticket is decided again\. If it still needs you, a new item comes to the board\.\s*Anything you typed stays below to copy\. It is not recorded\./);
  assert.deepEqual(listed(live.body), { open: [other.item.decision], ended: [item.decision] }, "it moves to answered or withdrawn today");
  assert.match(live.body, /· 1 open/);

  // Cancelled by an outside close.
  withdraw(board, other.ticket, other.item, "The issue was closed on GitLab by someone else.", "cancelled");
  assert.match(stateOf((await board.get(`${BOARD_LIVE_PATH}?item=${other.item.id}`)).body).text, /closed on GitLab.*\s*The ticket is cancelled, so nothing more is asked\./);
});

test("a withdrawn item's form is locked: nothing in it can be sent", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  withdraw(board, ticket, item, "A vision change reworded a line in this item's vision check.", "deciding");

  const page = await board.get(`/?item=${item.id}`);
  const form = parsePage(page.body).forms.find((f) => f.controls.some((c) => c.name === "answer"))!;
  assert.ok(form.controls.filter((c) => c.type === "radio" || c.type === "checkbox").every((c) => c.disabled), "every choice is disabled");
  assert.match(page.body, /<form id="answer-form" class="answer" data-locked="true">/);
  assert.equal((page.body.match(/<textarea [^>]* readonly>/g) ?? []).length, 2, "text fields stay readable to copy, but read-only");
  assert.ok(!form.controls.some((c) => c.tag === "button" || c.type === "submit"), "no button sends it");
  assert.match(page.body, /document\.addEventListener\("submit"[\s\S]*dataset\.locked === "true"\) event\.preventDefault\(\)/, "a locked form refuses to submit");
  assert.equal(stateOf(page.body).key, "withdrawn:");
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

  const board = async () => listed((await send(server.info.port, { path: "/" })).body);
  t.mock.timers.setTime(new Date(2026, 10, 9, 23, 59, 59).getTime());
  assert.deepEqual(await board(), { open: [open.item.decision], ended: [answered.item.decision, withdrawn.item.decision] });

  t.mock.timers.setTime(new Date(2026, 10, 10, 0, 0, 0).getTime());
  assert.deepEqual(await board(), { open: [open.item.decision], ended: [] }, "they leave the board at the end of the day");

  const left = await send(server.info.port, { path: `/?item=${answered.item.id}` });
  assert.match(parsePage(left.body).text, /This item has left the board: it was answered before today\. Its ticket's history keeps it/);
  assert.equal((await send(server.info.port, { path: "/?item=999" })).status, 404);
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
    key: "paused",
    locked: "true",
    text: "This item is locked: this repo is paused.\nIts form unlocks once the repo is resumed and entail has caught up with it.",
  });
  const form = parsePage(pausedPage.body).forms.find((f) => f.controls.some((c) => c.name === "answer"))!;
  assert.ok(form.controls.filter((c) => c.type === "radio").every((c) => c.disabled));
  assert.deepEqual(listed(pausedPage.body).open, [paused.item.decision, unreachable.item.decision], "a paused repo's items stay listed");
  assert.match(pausedPage.body, /<span class="tag status">locked<\/span>/);

  const haltedState = stateOf((await board.get(`/?item=${unreachable.item.id}`)).body);
  assert.equal(haltedState.key, "halted:gitlab.com");
  assert.match(haltedState.text, /^This item is locked: entail cannot reach gitlab\.com\./);

  board.store.saveSettings(board.github.id, { paused: false }, "Ada Owner");
  halted.clear();
  assert.equal(stateOf((await board.get(`${BOARD_LIVE_PATH}?item=${paused.item.id}`)).body).key, "open");
  assert.equal(stateOf((await board.get(`${BOARD_LIVE_PATH}?item=${unreachable.item.id}`)).body).locked, "false");
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
  assert.match(stateOf(page.body).text, /^Answered by Ada Owner at .*: Any Unicode whitespace separates words\s*Next decision$/);
});

/** An element as much as the page's script touches it. */
interface FakeElement {
  id: string;
  tagName: string;
  type: string;
  dataset: Record<string, string>;
  readOnly: boolean;
  disabled: boolean;
  value: string;
  html: string;
  elements?: FakeElement[];
  replaceWith(next: FakeElement): void;
}

/** Just enough of a browser to run the board's live script against the real server: no reload, no navigation. */
function fakeBrowser(port: number, html: string) {
  const ids = new Map<string, FakeElement>();
  const element = (id: string, tagName: string, outer: string, extra: Partial<FakeElement> = {}): FakeElement => {
    const dataset: Record<string, string> = {};
    for (const m of (/^<[^>]*>/.exec(outer)?.[0] ?? "").matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      dataset[m[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = decodeEntities(m[2]!);
    }
    const el: FakeElement = {
      id,
      tagName,
      type: "",
      dataset,
      readOnly: false,
      disabled: false,
      value: "",
      html: outer,
      replaceWith(next) {
        ids.set(id, next);
      },
      getAttribute: (name: string) => (new RegExp(`^<[^>]* ${name}="([^"]*)"`).exec(outer)?.[1] ?? null),
      ...extra,
    };
    return el;
  };
  const byId = (source: string, id: string): FakeElement | null => {
    const start = source.indexOf(`id="${id}"`);
    if (start < 0) return null;
    const open = source.lastIndexOf("<", start);
    const tag = /^<([a-z]+)/.exec(source.slice(open))![1]!;
    return element(id, tag.toUpperCase(), source.slice(open, source.indexOf(`</${tag}>`, open) + tag.length + 3));
  };
  for (const id of ["board", "board-count", "board-list", "item-state"]) ids.set(id, byId(html, id)!);
  const control = (tagName: string, type: string, name: string): FakeElement => ({ ...element(name, tagName, ""), type });
  const typed = { ...control("TEXTAREA", "textarea", "text"), value: "Only ASCII whitespace, please." };
  const note = { ...control("TEXTAREA", "textarea", "note"), value: "My private note." };
  const controls = [control("INPUT", "hidden", "item"), control("INPUT", "radio", "answer"), control("INPUT", "radio", "answer"), typed, control("INPUT", "checkbox", "show_note"), note];
  const shown = byId(html, "answer-form");
  const form = { ...shown!, elements: controls };
  if (shown) ids.set("answer-form", form);

  let poll: (() => Promise<void>) | undefined;
  const listeners: string[] = [];
  const document = {
    title: "",
    getElementById: (id: string) => ids.get(id) ?? null,
    importNode: (node: FakeElement) => node,
    addEventListener: (type: string) => void listeners.push(type),
  };
  class DOMParser {
    parseFromString(source: string) {
      return { title: decodeEntities(/<title>([^<]*)<\/title>/.exec(source)?.[1] ?? ""), getElementById: (id: string) => byId(source, id) };
    }
  }
  const fetchLocal = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  const setInterval = (fn: () => Promise<void>, ms: number) => {
    poll = fn;
    return ms;
  };
  const navigated: string[] = [];
  const location = { assign: (href: string) => void navigated.push(href) };
  new Function("document", "DOMParser", "fetch", "setInterval", "location", BOARD_SCRIPT)(document, DOMParser, fetchLocal, setInterval, location);
  assert.ok(poll, "the script starts polling");
  assert.deepEqual(listeners, ["submit"]);
  return { ids, form, typed, note, controls, document, navigated, poll: () => poll!() };
}

test("the page refreshes the board without a reload, and a withdrawn item's form locks with its typed text kept", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const browser = fakeBrowser(board.server.info.port, (await board.get(`/?item=${item.id}`)).body);
  const shownForm = browser.form;

  await browser.poll();
  assert.equal(browser.ids.get("item-state")!.dataset.key, "open");
  assert.equal(browser.form.dataset.locked, "false");

  // A newer item arrives on another repo: the list and count refresh in place.
  board.advance(1);
  const newer = board.raise(board.gitlab, 8, { kind: "contradiction" });
  await browser.poll();
  assert.deepEqual(listed(browser.ids.get("board-list")!.html).open, [item.decision, newer.item.decision]);
  assert.match(browser.ids.get("board-count")!.html, /· 2 open/);
  assert.equal(browser.document.title, "Board (2) · entail");
  assert.ok(!browser.controls.some((c) => c.disabled || c.readOnly), "the open item's form stays as it was");

  withdraw(board, ticket, item, "The issue was edited.", "deciding");
  await browser.poll();
  const state = browser.ids.get("item-state")!;
  assert.equal(state.dataset.key, `withdrawn:${newer.item.id}`);
  assert.match(state.html, /The issue was edited\./);
  assert.equal(browser.ids.get("answer-form"), shownForm, "the form itself is never replaced");
  assert.equal(shownForm.dataset.locked, "true");
  assert.deepEqual(
    browser.controls.map((c) => [c.id, c.disabled, c.readOnly]),
    [
      ["item", false, false],
      ["answer", true, false],
      ["answer", true, false],
      ["text", false, true],
      ["show_note", true, false],
      ["note", false, true],
    ],
    "choices are disabled and text fields read-only",
  );
  assert.equal(browser.typed.value, "Only ASCII whitespace, please.", "typed text stays visible to copy");
  assert.equal(browser.note.value, "My private note.");
  assert.deepEqual(listed(browser.ids.get("board-list")!.html), { open: [newer.item.decision], ended: [item.decision] });
});

const nextLinkTo = (html: string) => /<a class="next-decision" href="([^"]*)">Next decision<\/a>/.exec(html)?.[1];

test("an empty board shows the oldest item once one is raised", async (t) => {
  const board = await serveBoard(t);
  const browser = fakeBrowser(board.server.info.port, (await board.get("/")).body);
  await browser.poll();
  assert.deepEqual(browser.navigated, [], "nothing to show yet");

  const first = board.raise(board.github, 7, { kind: "contradiction" });
  board.advance(1);
  board.raise(board.gitlab, 8, { kind: "contradiction" });
  await browser.poll();
  assert.deepEqual(browser.navigated, [`/?item=${first.item.id}`], "the oldest open item is opened");
  assert.match((await board.get(browser.navigated[0]!)).body, new RegExp(first.item.decision.slice(0, 20)));
});

test("a withdrawn or answered item offers Next decision to the oldest open item, and the page never moves on by itself", async (t) => {
  const board = await serveBoard(t);
  const a = board.raise(board.github, 7, { kind: "contradiction" });
  board.advance(1);
  const b = board.raise(board.gitlab, 8, { kind: "contradiction" });
  board.advance(1);
  const c = board.raise(board.github, 9, { kind: "contradiction" });

  const open = await board.get(`/?item=${a.item.id}`);
  assert.equal(nextLinkTo(open.body), undefined, "an open item has no Next decision");

  const browser = fakeBrowser(board.server.info.port, open.body);
  withdraw(board, a.ticket, a.item, "The issue was edited.", "deciding");
  await browser.poll();
  assert.equal(nextLinkTo(browser.ids.get("item-state")!.html), `/?item=${b.item.id}`);
  assert.deepEqual(browser.navigated, [], "it does not move on by itself");
  assert.equal(browser.typed.value, "Only ASCII whitespace, please.");
  assert.equal(nextLinkTo((await board.get(`/?item=${a.item.id}`)).body), `/?item=${b.item.id}`, "the server render carries it too");

  board.store.recordAnswer({ boardItemId: b.item.id, answeredBy: "Ada Owner", shape: "dont-go-ahead" });
  const answered = await board.get(`/?item=${b.item.id}`);
  assert.equal(nextLinkTo(answered.body), `/?item=${c.item.id}`, "answered elsewhere: Next decision opens the oldest still open");

  withdraw(board, c.ticket, c.item, "The issue was closed.", "cancelled");
  assert.equal(nextLinkTo((await board.get(`/?item=${c.item.id}`)).body), undefined, "nothing else is open");
  assert.equal(nextLinkTo((await board.get(`${BOARD_LIVE_PATH}?item=${c.item.id}`)).body), undefined);
});
