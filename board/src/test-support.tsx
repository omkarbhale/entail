import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ActionView, CallView, HeldView, LogPage, LogRow, RepoView, SettingsView, StatusView, WaitingResponse } from "./api.ts";
import { App } from "./App.tsx";

/** A fake of entail's API for the board's tests: canned answers, recorded requests, and answers held back or failed on demand. */

export interface FakeState {
  waiting: WaitingResponse;
  repos: RepoView[];
  settings: SettingsView;
  status: StatusView;
  log: (query: URLSearchParams) => LogPage;
}

type Reply = { status: number; body: unknown } | "network";
type Route = (method: string, path: string, body: any, query: URLSearchParams) => Reply | undefined;

export function fakeApi(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    waiting: { items: [], held: [], actedAlone: { count: 0, repos: [] } },
    repos: [aRepo()],
    settings: { owner: "Omkar", model: "claude-opus-5-5", effort: "low", notice: null },
    status: { watching: true, repos: 1, checkedAt: new Date(Date.now() - 40_000).toISOString(), checking: false, url: "http://127.0.0.1:4380/" },
    log: () => ({ rows: [], next: null, counts: { all: 0, waiting: 0, overridden: 0, questions: 0, prs: 0 } }),
    ...initial,
  };
  const requests: { method: string; path: string; body: any }[] = [];
  const gates: { pattern: RegExp; promise: Promise<void> }[] = [];
  const failures: { pattern: RegExp; reply: Reply; once: boolean }[] = [];
  const routes: Route[] = [];

  const defaults: Route = (method, path, body, query) => {
    // As entail does, an answer whose window has closed is no longer held.
    if (method === "GET" && path === "/api/waiting") return { status: 200, body: { ...state.waiting, held: state.waiting.held.filter((one) => Date.parse(one.holdUntil) > Date.now()) } };
    if (method === "GET" && path === "/api/repos") return { status: 200, body: { repos: state.repos } };
    if (method === "GET" && path === "/api/settings") return { status: 200, body: state.settings };
    if (method === "GET" && path === "/api/status") return { status: 200, body: state.status };
    if (method === "GET" && path === "/api/log") return { status: 200, body: state.log(query) };
    const act = /^\/api\/calls\/(\d+)\/(confirm|override|answer|undo)$/u.exec(path);
    if (method === "POST" && act !== null) {
      const id = Number(act[1]);
      const item = state.waiting.items.find((one) => one.id === id) ?? state.waiting.held.find((one) => one.item.id === id)?.item;
      if (act[2] === "undo") {
        const held = state.waiting.held.find((one) => one.item.id === id);
        if (held === undefined) return { status: 409, body: { error: "too late to undo: entail is already acting on it; override the call instead" } };
        state.waiting = { ...state.waiting, held: state.waiting.held.filter((one) => one !== held), items: [...state.waiting.items, held.item] };
        return { status: 200, body: { undone: held.action, call: held.item } };
      }
      if (item === undefined) return { status: 404, body: { error: `no call ${id}` } };
      const holdUntil = new Date(Date.now() + 10_000).toISOString();
      const action: ActionView = {
        id: id + 1000,
        type: act[2] === "confirm" ? "confirmed" : act[2] === "override" ? "overridden" : "answered",
        at: new Date().toISOString(),
        by: "Omkar",
        call: id,
        holdUntil,
        ...(act[2] === "override" ? { to: body.call, reason: body.reason, ...(body.differently ? { differently: true as const } : {}) } : {}),
        ...(act[2] === "answer" ? { to: body.call, answer: body.answer } : {}),
      };
      state.waiting = { ...state.waiting, items: state.waiting.items.filter((one) => one.id !== id), held: [...state.waiting.held, { item, action, holdUntil }] };
      return { status: 200, body: action };
    }
    return undefined;
  };

  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://127.0.0.1:4380");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, body });
    const key = `${method} ${url.pathname}`;
    for (const gate of gates.filter((one) => one.pattern.test(key))) await gate.promise;
    const failure = failures.find((one) => one.pattern.test(key));
    let reply: Reply | undefined;
    if (failure !== undefined) {
      if (failure.once) failures.splice(failures.indexOf(failure), 1);
      reply = failure.reply;
    } else {
      for (const route of [...routes, defaults]) {
        reply = route(method, url.pathname, body, url.searchParams);
        if (reply !== undefined) break;
      }
    }
    if (reply === "network") throw new TypeError("Failed to fetch");
    reply ??= { status: 404, body: { error: `nothing at ${url.pathname}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);

  return {
    state,
    requests,
    /** The requests whose method and path match, such as "POST /api/calls/1/confirm". */
    sent: (pattern: RegExp) => requests.filter((one) => pattern.test(`${one.method} ${one.path}`)),
    /** Holds back every answer to matching requests until the returned function is called. */
    hold(pattern: RegExp): () => void {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      const gate = { pattern, promise };
      gates.push(gate);
      return () => {
        gates.splice(gates.indexOf(gate), 1);
        release();
      };
    },
    fail(pattern: RegExp, reply: Reply = "network", once = true) {
      failures.push({ pattern, reply, once });
    },
    route(route: Route) {
      routes.unshift(route);
    },
  };
}

export function renderBoard(hash = "#/waiting") {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  return { client, ...render(<App client={client} />) };
}

let nextId = 1;

export function aCall(overrides: Partial<CallView> = {}): CallView {
  const id = overrides.id ?? nextId++;
  const number = overrides.issue?.number ?? 100 + id;
  return {
    id,
    kind: "issue",
    pr: null,
    repo: "omkarbhale/entail",
    issue: { number, title: `Issue ${number}`, url: `https://github.com/omkarbhale/entail/issues/${number}`, author: "reporter", createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    issueText: `# Issue ${number}\n\nThe body.\n`,
    body: "Make the background of the board bright pink with glitter.",
    visionCommit: "8973851abcdef",
    call: "no",
    reason: "A louder board does not make any decision faster or clearer.",
    criteria: [],
    question: null,
    restsOn: { visionLines: [{ text: "Its value over chat is structure.", url: "https://github.com/omkarbhale/entail/blob/8973851/VISION.md#L48", line: 48 }], cases: [] },
    judgedAt: new Date(Date.now() - 3600_000).toISOString(),
    trigger: "new",
    owner: null,
    model: "claude-opus-5-5",
    effort: "low",
    costUsd: 0.05,
    confirmMode: true,
    status: "waiting",
    settledBy: null,
    posted: { url: `https://github.com/omkarbhale/entail/issues/${number}#issuecomment-1`, closed: false },
    rejudged: false,
    waitingSince: new Date(Date.now() - 3600_000).toISOString(),
    ...overrides,
  };
}

export function aQuestion(overrides: Partial<CallView> = {}): CallView {
  return aCall({
    call: "ask",
    reason: "Both readings fit the vision's definition of a word, and they print different counts.",
    question: { question: "Should a non-breaking space separate two words?", why: "“10 km” counts as 2 words one way and 1 the other.", large: false },
    ...overrides,
  });
}

/** A call on a PR that closes an issue, with a checklist, GitHub's facts and a sorted beyond list. */
export function aPullRequestCall(overrides: Partial<CallView> = {}): CallView {
  const base = aCall({ call: "merge", reason: "It does what the issue asked and nothing unwanted.", criteria: [], ...overrides });
  const number = base.issue.number + 1000;
  return {
    ...base,
    kind: "pr",
    trigger: "opened",
    body: "Counts words by whitespace.",
    pr: {
      number,
      title: `Fix for ${base.issue.number}`,
      url: `https://github.com/omkarbhale/entail/pull/${number}`,
      author: "builder",
      head: "abc1234def",
      base: "fed4321cba",
      solves: { solved: true, evidence: "src/count.ts splits on whitespace." },
      checklist: [
        { criterion: "Counts words separated by whitespace", met: true, evidence: "src/count.ts:12" },
        { criterion: "Prints the count alone", met: false, evidence: "It also prints a header." },
      ],
      beyond: [
        { change: "Renames a helper", sort: "harmless", why: "Internal only." },
        { change: "Adds a flag", sort: "unwanted", why: "Nobody asked for it." },
      ],
      needsToChange: [],
      productCall: false,
      guard: null,
      facts: {
        checks: [
          { name: "test", status: "passed", reported: true, url: null },
          { name: "lint", status: "passed", reported: true, url: null },
        ],
        required: [],
        files: [{ path: "src/count.ts", status: "modified", previousPath: null, additions: 3, deletions: 1 }],
        ciGreen: true,
        touched: { vision: false, pins: [] },
      },
      sendBacks: 0,
      cancel: false,
      outcome: null,
      ...overrides.pr,
    },
  };
}

export function aRepo(overrides: Partial<RepoView> = {}): RepoView {
  return {
    repo: "omkarbhale/entail",
    enrolled: true,
    since: "2026-11-10T09:00:00.000Z",
    confirm: true,
    model: null,
    effort: null,
    uses: { model: "claude-opus-5-5", effort: "low" },
    calls: 6,
    waiting: 2,
    checked: 2,
    agreed: 1,
    suggestConfirmOff: false,
    vision: { commit: "8973851abcdef", url: "https://github.com/omkarbhale/entail/blob/8973851abcdef/VISION.md" },
    pins: { file: "/home/me/.local/share/entail/pins/github.com/omkarbhale/entail.md", topics: [] },
    checkedAt: new Date(Date.now() - 40_000).toISOString(),
    backlogAsked: false,
    ...overrides,
  };
}

export function aRow(call: CallView, overrides: Partial<LogRow> = {}): LogRow {
  return {
    day: call.judgedAt.slice(0, 10),
    call,
    ownerCall: null,
    reopened: false,
    trail: [{ at: call.judgedAt, text: `Judged: ${call.call} · claude-opus-5-5, low` }],
    ...overrides,
  };
}

export function held(item: CallView, action: Partial<ActionView> = {}, ms = 10_000): HeldView {
  const holdUntil = new Date(Date.now() + ms).toISOString();
  return { item, holdUntil, action: { id: item.id + 1000, type: "confirmed", at: new Date().toISOString(), by: "Omkar", call: item.id, holdUntil, ...action } };
}
