import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { AnswerReply, BoardData, ItemView } from "../../src/app-view.ts";
import { BoardDriver, fillAnswer } from "./board-driver.ts";
import { FIXTURE_ISSUES, type TicketId } from "./fixture.ts";
import type { HarnessEvent } from "./reset.ts";

interface Item {
  id: number;
  ticket: TicketId;
  version: number;
  options: string[];
  answer?: Record<string, string>;
}

/**
 * A stand-in for entail's board server with the rules the driver must meet:
 * its own Host only, its own Origin on writes, the per-start token on every
 * answer, and answers only to the item version shown, and only once.
 */
async function fakeBoard(t: TestContext, items: Item[]) {
  const token = randomBytes(16).toString("hex");
  const requests: string[] = [];
  const title = (item: Item) => FIXTURE_ISSUES.find((i) => i.id === item.ticket)!.title;
  const issueUrl = (item: Item) => `https://github.com/owner/entail-fixture-tally/issues/${FIXTURE_ISSUES.findIndex((i) => i.id === item.ticket) + 1}`;
  const view = (item: Item): ItemView => ({
    kind: "item",
    id: item.id,
    version: item.version,
    ticketId: item.id,
    status: item.answer ? "answered" : "open",
    meta: { repo: "github.com/owner/entail-fixture-tally", forge: "GitHub", issueNumber: 1, raisedAt: "2026-11-09T09:00:00.000Z", ago: "just now" },
    decision: `Decide ${title(item)}`,
    state: item.answer
      ? {
          kind: "answered",
          receipt: {
            answeredBy: "Owner",
            answeredAt: "2026-11-09T09:01:00.000Z",
            itemVersion: item.version,
            words: item.answer.text || item.answer.answer!,
            note: { text: null, shown: false },
            outcome: { stateWords: "deciding", next: [] },
            comment: null,
            posted: null,
            unreachable: null,
          },
        }
      : { kind: "open" },
    why: "Needs the owner.",
    visionCheck: null,
    ticket: { title: title(item), number: 1, href: issueUrl(item), filedBy: null, request: "" },
    happened: null,
    historyPath: `/ticket?id=${item.id}`,
    form: { options: item.options.map((o, n) => ({ id: `R${n}`, title: o, outcome: "", warning: null })), dontGoAheadOutcome: "" },
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    requests.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return send(421, "wrong host");
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "GET" && url.pathname === "/board/data") {
      const asked = url.searchParams.get("item");
      const open = items.filter((i) => !i.answer);
      const shown = asked === null ? open[0] : items.find((i) => i.id === Number(asked));
      const data: Partial<BoardData> = {
        token,
        open: open.map((i) => ({ id: i.id, decision: `Decide ${title(i)}`, repo: "", forge: "", ago: "", why: { kind: "pin", tag: "pin" }, status: "open", locked: false })),
        detail: shown ? view(shown) : { kind: "empty" },
      };
      return send(200, data);
    }
    if (req.method !== "POST" || url.pathname !== "/board/answer") return send(404, "no such page");
    if (req.headers.origin !== origin) return send(403, "wrong origin");
    if (form.get("token") !== token) return send(403, "missing or wrong form token");
    const item = items.find((i) => i.id === Number(form.get("item")));
    if (!item) return send(404, "no such item");
    const draft = { answer: form.get("answer") ?? "", text: form.get("text") ?? "", note: form.get("note") ?? "", showNote: form.has("show_note") };
    const refused = (refusal: string): AnswerReply => ({ kind: "form", itemId: item.id, draft, error: null, refusal });
    if (Number(form.get("version")) !== item.version) return send(409, refused("this item has a newer version"));
    if (item.answer) return send(409, refused("this item is already answered"));
    if (form.get("step") === "review") {
      return send(200, { kind: "review", itemId: item.id, draft, review: { owner: "Owner", words: draft.text, warning: null, note: { text: null, shown: false }, outcome: { stateWords: "deciding", next: [] }, comment: null } } satisfies AnswerReply);
    }
    item.answer = Object.fromEntries(form);
    return send(200, { kind: "recorded", itemId: item.id } satisfies AnswerReply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, token, requests };
}

test("the board driver answers through the board with the per-start token, and leaves T8 unanswered", async (t) => {
  const items: Item[] = [
    { id: 1, ticket: "T7", version: 1, options: ["Go ahead as read"] },
    { id: 2, ticket: "T8", version: 1, options: ["Go ahead as read"] },
    { id: 3, ticket: "T9", version: 2, options: ["Go ahead as read"] },
    { id: 4, ticket: "T13", version: 1, options: ["Only ASCII whitespace separates words", "Any Unicode whitespace separates words"] },
    { id: 5, ticket: "T5", version: 1, options: [] },
  ];
  const board = await fakeBoard(t, items);
  const events: HarnessEvent[] = [];
  const driver = new BoardDriver({ boardUrl: board.url, log: (e) => events.push(e) });

  await driver.pass();

  const answer = (id: number) => items.find((i) => i.id === id)!.answer;
  assert.equal(answer(1)?.answer, "dont-go-ahead");
  assert.equal(answer(2), undefined, "T8 is left unanswered");
  assert.deepEqual(answer(3), {
    token: board.token,
    item: "3",
    version: "2",
    answer: "own-words",
    text: "Rename only; keep every exported name and the printed output unchanged.",
    note: "",
    step: "record",
  });
  assert.equal(answer(4)?.text, "Any Unicode whitespace separates words, including a non-breaking space.");
  assert.equal(answer(5)?.answer, "own-words", "an extra item on a ticket expected to merge is answered");
  assert.ok(board.requests.every((r) => /^(GET \/board\/data|POST \/board\/answer)/.test(r)), "only the board is read and answered");
  const steps = board.requests.filter((r) => r.startsWith("POST"));
  assert.equal(steps.length, 8, "each of the four answers is reviewed, then recorded");

  const byTicket = Object.fromEntries(events.map((e) => [e.ticket, e]));
  assert.equal(byTicket.T8?.event, "left-unanswered");
  assert.equal(byTicket.T5?.extra, true, "the extra item is reported");
  assert.equal(byTicket.T9?.extra, false);
  assert.match(String(byTicket.T9?.receipt), /Answered by Owner .* item version 2/);

  const before = events.length;
  await driver.pass();
  assert.equal(events.length, before, "nothing is answered twice");
});

test("the fake board refuses an answer without the token, so the driver's answers carried it", async (t) => {
  const items: Item[] = [{ id: 1, ticket: "T7", version: 1, options: [] }];
  const board = await fakeBoard(t, items);
  const response = await fetch(new URL("/board/answer", board.url), {
    method: "POST",
    headers: { Origin: new URL(board.url).origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: "item=1&version=1&answer=dont-go-ahead&step=record",
  });
  assert.equal(response.status, 403);
  assert.equal(items[0]!.answer, undefined);
});

test("a refused answer is reported and retried at most three times", async (t) => {
  const items: Item[] = [{ id: 1, ticket: "T7", version: 1, options: [] }];
  const board = await fakeBoard(t, items);
  const events: HarnessEvent[] = [];
  const driver = new BoardDriver({
    boardUrl: board.url,
    log: (e) => events.push(e),
    // Drop the Origin header, as a page on another origin could not set it.
    fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Origin: "http://evil.example" } }),
  });
  for (let pass = 0; pass < 5; pass += 1) await driver.pass();
  assert.deepEqual(
    events.map((e) => [e.event, e.attempt]),
    [
      ["answer-failed", 1],
      ["answer-failed", 2],
      ["answer-failed", 3],
    ],
  );
  assert.match(String(events[0]!.error), /403/);
});

test("filling the answer picks a named option, or falls back to the owner's own words", () => {
  const options = [{ id: "R1", title: "Go ahead as read", outcome: "", warning: null }];
  assert.deepEqual(fillAnswer(options, { shape: "option", label: "Go ahead as read", fallback: "x" }), { answer: "option:R1", text: "", note: "", showNote: false });
  assert.deepEqual(fillAnswer(options, { shape: "option", label: "Merge this PR as it is", fallback: "my words" }), {
    answer: "own-words",
    text: "my words",
    note: "",
    showNote: false,
  });
  assert.equal(fillAnswer(options, { shape: "don't go ahead" }).answer, "dont-go-ahead");
  assert.throws(() => fillAnswer(options, { shape: "option", label: "Merge this PR as it is", fallback: "" }), /no option/);
});
