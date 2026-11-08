import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { BoardDriver, fillAnswer } from "./board-driver.ts";
import { FIXTURE_ISSUES, type TicketId } from "./fixture.ts";
import { parsePage } from "./html.ts";
import type { HarnessEvent } from "./reset.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface Item {
  id: string;
  ticket: TicketId;
  version: number;
  options: string[];
  answer?: Record<string, string>;
}

/**
 * A stand-in for entail's board server with the rules the driver must meet:
 * its own Host only, its own Origin on writes, the per-start token on every
 * form, and answers only to the item version shown, and only once.
 */
async function fakeBoard(t: TestContext, items: Item[]) {
  const token = randomBytes(16).toString("hex");
  const requests: string[] = [];
  const title = (item: Item) => FIXTURE_ISSUES.find((i) => i.id === item.ticket)!.title;
  const issueUrl = (item: Item) => `https://github.com/owner/entail-fixture-tally/issues/${FIXTURE_ISSUES.findIndex((i) => i.id === item.ticket) + 1}`;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    requests.push(`${req.method} ${req.url}`);
    const send = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><nav><a href="/">Board</a> <a href="/calls">Calls</a></nav>${body}</body></html>`);
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return send(421, "wrong host");
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (req.method === "POST") {
      if (req.headers.origin !== origin) return send(403, "wrong origin");
      if (form.get("token") !== token) return send(403, "missing or wrong form token");
    }
    const path = req.url ?? "/";
    if (path === "/") {
      const open = items.filter((i) => !i.answer);
      return send(200, `<h1>Board</h1><h2>Needs you</h2><ul>${open.map((i) => `<li><a href="/items/${i.id}">Decide ${esc(title(i))}</a></li>`).join("")}</ul>`);
    }
    if (path === "/calls") return send(200, "<h1>Calls</h1>");
    const match = /^\/items\/([^/]+)(?:\/(review|record))?$/.exec(path);
    const item = items.find((i) => i.id === match?.[1]);
    if (!match || !item) return send(404, "no such item");
    if (!match[2]) {
      if (item.answer) return send(200, `<p>Answered by Owner.</p>`);
      const radios = [
        ...item.options.map((o, n) => `<label><input type="radio" name="shape" value="option:${n}"> ${esc(o)}</label>`),
        `<label><input type="radio" name="shape" value="own"> Answer in my own words</label>`,
        `<label for="text">What should happen?</label><textarea id="text" name="text" placeholder="An executor will build from this."></textarea>`,
        `<label><input type="radio" name="shape" value="stop"> Don't go ahead</label>`,
      ];
      return send(
        200,
        `<h1>Decision for ${item.id}</h1><p>Raised by <a href="${issueUrl(item)}">${esc(title(item))}</a></p>
        <form method="post" action="/items/${item.id}/review">
          <input type="hidden" name="token" value="${token}"><input type="hidden" name="version" value="${item.version}">
          ${radios.join("\n")}
          <details><summary>Add a note</summary><textarea name="note" placeholder="Optional."></textarea>
          <label><input type="checkbox" name="show_note"> Show my note on the issue</label></details>
          <button type="submit">Review answer</button>
        </form>`,
      );
    }
    if (Number(form.get("version")) !== item.version) return send(409, "this item has a newer version");
    if (item.answer) return send(409, "this item is already answered");
    if (match[2] === "review") {
      const hidden = [...form].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
      return send(200, `<p>Review: nothing is recorded yet.</p><form method="post" action="/items/${item.id}/record">${hidden}<button>Record answer as Owner (final)</button></form><a href="/items/${item.id}">Back</a>`);
    }
    item.answer = Object.fromEntries(form);
    return send(200, `<p>Recorded: Owner answered ${item.id}, version ${item.version}.</p><form method="get" action="/"><button>Next decision</button></form>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, token, requests };
}

test("the board driver answers through the board form with the per-start token, and leaves T8 unanswered", async (t) => {
  const items: Item[] = [
    { id: "a", ticket: "T7", version: 1, options: ["Go ahead as read"] },
    { id: "b", ticket: "T8", version: 1, options: ["Go ahead as read"] },
    { id: "c", ticket: "T9", version: 2, options: ["Go ahead as read"] },
    { id: "d", ticket: "T13", version: 1, options: ["Only ASCII whitespace separates words", "Any Unicode whitespace separates words"] },
    { id: "e", ticket: "T5", version: 1, options: [] },
  ];
  const board = await fakeBoard(t, items);
  const events: HarnessEvent[] = [];
  const driver = new BoardDriver({ boardUrl: board.url, log: (e) => events.push(e) });

  await driver.pass();

  const answer = (id: string) => items.find((i) => i.id === id)!.answer;
  assert.equal(answer("a")?.shape, "stop");
  assert.equal(answer("b"), undefined, "T8 is left unanswered");
  assert.deepEqual(answer("c"), {
    token: board.token,
    version: "2",
    shape: "own",
    text: "Rename only; keep every exported name and the printed output unchanged.",
    note: "",
  });
  assert.equal(answer("d")?.text, "Any Unicode whitespace separates words, including a non-breaking space.");
  assert.equal(answer("e")?.shape, "own", "an extra item on a ticket expected to merge is answered");
  assert.equal(board.requests.includes("GET /calls"), false, "only board pages are read");

  const byTicket = Object.fromEntries(events.map((e) => [e.ticket, e]));
  assert.equal(byTicket.T8?.event, "left-unanswered");
  assert.equal(byTicket.T5?.extra, true, "the extra item is reported");
  assert.equal(byTicket.T9?.extra, false);
  assert.match(String(byTicket.T9?.receipt), /Recorded: Owner answered c/);

  const before = events.length;
  await driver.pass();
  assert.equal(events.length, before, "nothing is answered twice");
});

test("the fake board refuses an answer without the token, so the driver's answers carried it", async (t) => {
  const items: Item[] = [{ id: "a", ticket: "T7", version: 1, options: [] }];
  const board = await fakeBoard(t, items);
  const response = await fetch(new URL("/items/a/record", board.url), {
    method: "POST",
    headers: { Origin: new URL(board.url).origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: "version=1&shape=stop",
  });
  assert.equal(response.status, 403);
  assert.equal(items[0]!.answer, undefined);
});

test("a refused answer is reported and retried at most three times", async (t) => {
  const items: Item[] = [{ id: "a", ticket: "T7", version: 1, options: [] }];
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

test("filling the form picks a named option, or falls back to the owner's own words", () => {
  const page = parsePage(`<form method="post"><label><input type="radio" name="s" value="1"> Go ahead as read</label>
    <label><input type="radio" name="s" value="2" checked> Answer in my own words</label><textarea name="words"></textarea>
    <label><input type="radio" name="s" value="3"> Don&#39;t go ahead</label><button>Review answer</button></form>`);
  const form = page.forms[0]!;
  const picked = fillAnswer(form, { shape: "option", label: "Go ahead as read", fallback: "x" });
  assert.deepEqual(picked.controls.filter((c) => c.checked).map((c) => c.value), ["1"]);
  assert.equal(form.controls.find((c) => c.value === "2")!.checked, true, "the page's form is not changed");

  const fallback = fillAnswer(form, { shape: "option", label: "Merge this PR as it is", fallback: "my words" });
  assert.deepEqual(fallback.controls.filter((c) => c.checked).map((c) => c.value), ["2"]);
  assert.equal(fallback.controls.find((c) => c.name === "words")!.value, "my words");

  const stop = fillAnswer(form, { shape: "don't go ahead" });
  assert.deepEqual(stop.controls.filter((c) => c.checked).map((c) => c.value), ["3"]);
});
