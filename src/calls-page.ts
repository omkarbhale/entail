import { visionPermalink } from "./citation.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import type { Page, PageRequest, Reply } from "./server.ts";
import {
  CALL_KINDS,
  type AnswerRecord,
  type CallFilter,
  type CallRecord,
  type ModelRunRecord,
  type RepoRecord,
  type Store,
  type TicketRecord,
} from "./store.ts";
import { VISION_PATH } from "./vision.ts";

export const CALLS_PATH = "/calls";
export const MODEL_RUN_PATH = "/calls/model-run";
export const TICKET_PATH = "/ticket";

/** Each call kind as the Calls page names it; a shadow "would merge" call is one kind. */
export const CALL_KIND_LABELS: Readonly<Record<(typeof CALL_KINDS)[number], string>> = {
  intake: "intake",
  verdict: "verdict",
  raise: "raised to the board",
  "go-ahead": "going ahead on the owner's answer",
  "cancel-on-answer": "cancelled on the owner's answer",
  investigation: "investigation",
  findings: "findings arrived",
  criteria: "criteria",
  decline: "declined",
  "close-at-intake": "closed at intake",
  recheck: "re-check",
  landing: "landing check",
  "would-merge": "would merge (shadow)",
  merge: "merge",
  "cancel-on-outside-close": "cancelled on an outside close",
  "unenroll-cancel": "cancelled on unenroll",
  "pr-opened": "PR opened",
  "pr-closed": "PR closed unmerged",
  "merged-by-others": "merged by others",
  "new-push": "new push on a PR on the board",
  "issue-edit": "issue edited",
};

/** The query parameters the Calls page filters by. */
export const CALL_FILTERS = { repo: "repo", ticket: "ticket", kind: "kind", from: "from", to: "to", visionChange: "vision" } as const;

/** A ticket's page. */
export function ticketPath(ticketId: number): string {
  return `${TICKET_PATH}?id=${ticketId}`;
}

/** One model run's page, with its full input and output. */
export function modelRunPath(runId: number): string {
  return `${MODEL_RUN_PATH}?id=${runId}`;
}

/** A call, in place on the Calls page filtered to its ticket. */
export function callPath(call: Pick<CallRecord, "id" | "ticketId">): string {
  return `${CALLS_PATH}?${CALL_FILTERS.ticket}=${call.ticketId}#call-${call.id}`;
}

/** The repo as pages name it: its host and path. */
export function repoLabel(repo: Pick<RepoRecord, "host" | "path">): string {
  return `${repo.host}/${repo.path}`;
}

/** An issue on the repo's forge. */
export function issueUrl(repo: Pick<RepoRecord, "forge" | "host" | "path">, number: number): string {
  return repo.forge === "github"
    ? `https://${repo.host}/${repo.path}/issues/${number}`
    : `https://${repo.host}/${repo.path}/-/issues/${number}`;
}

/** A PR (a merge request on GitLab) on the repo's forge. */
export function pullRequestUrl(repo: Pick<RepoRecord, "forge" | "host" | "path">, number: number): string {
  return repo.forge === "github"
    ? `https://${repo.host}/${repo.path}/pull/${number}`
    : `https://${repo.host}/${repo.path}/-/merge_requests/${number}`;
}

/** A PR's name in text: `PR #n` on GitHub, `MR !n` on GitLab. */
function pullRequestName(repo: Pick<RepoRecord, "forge">, number: number): string {
  return repo.forge === "github" ? `PR #${number}` : `MR !${number}`;
}

/**
 * The Calls page and each model run's page (spec §14, ADR-0009). The Calls
 * page lists every call newest first, across all repos, and filters by repo,
 * ticket, kind, date and vision change, which combine; a vision change lists
 * the re-checks it caused (ADR-0016). A shadow "would merge" call is one
 * kind. Filters are plain links, because the page asks nothing and offers no
 * action: it has no form, and a wrong call is fixed through the issue, the
 * vision or a pin, never here.
 */
export function callsPages(store: Store): Page[] {
  return [
    {
      path: CALLS_PATH,
      nav: "Calls",
      get: (request) => callsView(store, request),
    },
    {
      path: MODEL_RUN_PATH,
      get: (request) => modelRunView(store, request),
    },
  ];
}

type FilterResult = { ok: true; filter: CallFilter } | { ok: false; problem: string };

/** Reads the filter from the page's query, refusing a value that is not one. */
export function parseCallFilter(query: URLSearchParams): FilterResult {
  const filter: CallFilter = {};
  for (const [key, name] of [
    ["repoId", CALL_FILTERS.repo],
    ["ticketId", CALL_FILTERS.ticket],
    ["visionChangeId", CALL_FILTERS.visionChange],
  ] as const) {
    const value = query.get(name);
    if (value === null || value === "") continue;
    const id = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) return { ok: false, problem: `${name} is not a record id: ${value}` };
    filter[key] = id;
  }
  const kind = query.get(CALL_FILTERS.kind);
  if (kind !== null && kind !== "") filter.kind = kind;
  for (const [key, name] of [
    ["fromDay", CALL_FILTERS.from],
    ["toDay", CALL_FILTERS.to],
  ] as const) {
    const value = query.get(name);
    if (value === null || value === "") continue;
    if (!isDay(value)) return { ok: false, problem: `${name} is not a day (YYYY-MM-DD): ${value}` };
    filter[key] = value;
  }
  return { ok: true, filter };
}

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The Calls page's query for a filter, with the given parts changed; undefined drops a part. */
function filterHref(filter: CallFilter, change: Partial<CallFilter>): string {
  const next = { ...filter, ...change };
  const query = new URLSearchParams();
  if (next.repoId !== undefined) query.set(CALL_FILTERS.repo, String(next.repoId));
  if (next.ticketId !== undefined) query.set(CALL_FILTERS.ticket, String(next.ticketId));
  if (next.kind !== undefined) query.set(CALL_FILTERS.kind, next.kind);
  if (next.fromDay !== undefined) query.set(CALL_FILTERS.from, next.fromDay);
  if (next.toDay !== undefined) query.set(CALL_FILTERS.to, next.toDay);
  if (next.visionChangeId !== undefined) query.set(CALL_FILTERS.visionChange, String(next.visionChangeId));
  const text = query.toString();
  return text === "" ? CALLS_PATH : `${CALLS_PATH}?${text}`;
}

function callsView(store: Store, request: PageRequest): Reply {
  const parsed = parseCallFilter(request.url.searchParams);
  if (!parsed.ok) {
    return {
      status: 400,
      html: renderPage(request, {
        title: "Calls",
        body: `<h1>Calls</h1>\n<p class="error">${escapeHtml(parsed.problem)}.</p>\n<p><a href="${CALLS_PATH}">Every call</a></p>`,
      }),
    };
  }
  const filter = parsed.filter;
  const calls = store.listCalls(filter);
  const context = new CallContext(store);
  const filtered = Object.values(filter).some((value) => value !== undefined);
  const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
  const list =
    calls.length === 0
      ? `<p class="muted">${filtered ? "No call matches these filters." : "No call has been recorded yet."}</p>`
      : calls.map((call) => renderCall(call, context, { heading: "h2", ticketLinks: true, filter })).join("\n");
  const body = `<h1>Calls</h1>
<p class="muted">Every call entail made, newest first. This page is read-only: to fix a wrong call, close the issue, revert the change, add a vision line or add a pin.</p>
${renderFilters(store, filter)}
<p><strong>${escapeHtml(count)}</strong>${filtered ? ` · <a href="${CALLS_PATH}">clear every filter</a>` : ""}</p>
${list}`;
  return { status: 200, html: renderPage(request, { title: "Calls", body }) };
}

/** The filters, as links that each change one part and keep the others. */
function renderFilters(store: Store, filter: CallFilter): string {
  const option = (label: string, change: Partial<CallFilter>, current: boolean) =>
    `<a href="${escapeHtml(filterHref(filter, change))}"${current ? ' aria-current="true"' : ""}>${escapeHtml(label)}</a>`;
  const row = (name: string, links: string[]) => `<p><span class="filter-name">${escapeHtml(name)}:</span> ${links.join(" ")}</p>`;

  const repos = store.listRepos();
  const repoLinks = [
    option("any", { repoId: undefined }, filter.repoId === undefined),
    ...repos.map((repo) => option(repoLabel(repo), { repoId: repo.id }, filter.repoId === repo.id)),
  ];

  const kinds: string[] = [...CALL_KINDS];
  if (filter.kind !== undefined && !kinds.includes(filter.kind)) kinds.push(filter.kind);
  const kindLinks = [
    option("any", { kind: undefined }, filter.kind === undefined),
    ...kinds.map((kind) => option(kindLabel(kind), { kind }, filter.kind === kind)),
  ];

  // The days on offer are those with calls under the other filters.
  const days = store.callDays({ ...filter, fromDay: undefined, toDay: undefined });
  const anyDay = filter.fromDay === undefined && filter.toDay === undefined;
  const dayLinks = [
    option("any", { fromDay: undefined, toDay: undefined }, anyDay),
    ...days.map(({ day, calls }) =>
      option(`${day} (${calls})`, { fromDay: day, toDay: day }, filter.fromDay === day && filter.toDay === day),
    ),
  ];
  if (!anyDay && !(filter.fromDay !== undefined && filter.fromDay === filter.toDay && days.some((d) => d.day === filter.fromDay))) {
    dayLinks.push(`<span aria-current="true">${escapeHtml(`from ${filter.fromDay ?? "the start"} to ${filter.toDay ?? "today"}`)}</span>`);
  }

  const ticketLinks = [option("any", { ticketId: undefined }, filter.ticketId === undefined)];
  if (filter.ticketId !== undefined) {
    ticketLinks.push(
      `<span aria-current="true">ticket ${filter.ticketId}</span> (<a href="${escapeHtml(ticketPath(filter.ticketId))}">its history</a>)`,
    );
  } else {
    ticketLinks.push(`<span class="muted">pick a ticket from a call below</span>`);
  }

  // A vision change lists every ticket it flagged and each re-check's outcome (ADR-0016).
  const repoOf = new Map(repos.map((repo) => [repo.id, repo]));
  const changes = store.listVisionChanges().filter((change) => filter.repoId === undefined || change.repoId === filter.repoId);
  const visionLinks = [
    option("any", { visionChangeId: undefined }, filter.visionChangeId === undefined),
    ...changes.map((change) => {
      const repo = repoOf.get(change.repoId);
      const label = `${change.commitSha.slice(0, 7)}${repo === undefined ? "" : ` in ${repoLabel(repo)}`} (${change.seenAt.slice(0, 10)})`;
      return option(label, { visionChangeId: change.id }, filter.visionChangeId === change.id);
    }),
  ];
  if (filter.visionChangeId !== undefined && !changes.some((change) => change.id === filter.visionChangeId)) {
    visionLinks.push(`<span aria-current="true">vision change ${filter.visionChangeId}</span>`);
  }

  return `<nav class="filters" aria-label="Filter calls">
${row("Repo", repoLinks)}
${row("Ticket", ticketLinks)}
${row("Kind", kindLinks)}
${row("Date", dayLinks)}
${row("Vision change", visionLinks)}
</nav>`;
}

function kindLabel(kind: string): string {
  return (CALL_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/**
 * What rendering calls needs beyond the call itself, read once per page: the
 * repos, each ticket and the answers calls cite.
 */
export class CallContext {
  readonly #store: Store;
  readonly #repos: Map<number, RepoRecord>;
  readonly #tickets = new Map<number, TicketRecord | null>();
  readonly #answers = new Map<number, Map<number, AnswerRecord>>();

  constructor(store: Store) {
    this.#store = store;
    this.#repos = new Map(store.listRepos().map((repo) => [repo.id, repo]));
  }

  get store(): Store {
    return this.#store;
  }

  repo(id: number): RepoRecord | null {
    return this.#repos.get(id) ?? null;
  }

  ticket(id: number): TicketRecord | null {
    if (!this.#tickets.has(id)) this.#tickets.set(id, this.#store.getTicket(id));
    return this.#tickets.get(id)!;
  }

  /** An answer given on the ticket's board items. */
  answer(ticketId: number, answerId: number): AnswerRecord | null {
    let answers = this.#answers.get(ticketId);
    if (answers === undefined) {
      answers = new Map();
      for (const { answer } of this.#store.boardItemsForTicket(ticketId)) if (answer) answers.set(answer.id, answer);
      this.#answers.set(ticketId, answers);
    }
    return answers.get(answerId) ?? null;
  }
}

export interface RenderCallOptions {
  /** The call's heading level: h2 on the Calls page, h3 within a ticket's history. */
  heading: "h2" | "h3";
  /** Whether to link the call's ticket page and its calls; a ticket page already is that page. */
  ticketLinks: boolean;
  /** The Calls page's filter, kept when filtering to the call's ticket. */
  filter?: CallFilter;
}

/**
 * One call as the audit pages show it (spec §14, ADR-0009): its reason,
 * citation permalinks, check and challenge results, links to the issue, the
 * PR and the comments it posted, and each model run behind it one click away.
 * The inputs it judged and what it decided are folded below.
 */
export function renderCall(call: CallRecord, context: CallContext, options: RenderCallOptions): string {
  const repo = context.repo(call.repoId);
  const ticket = context.ticket(call.ticketId);
  const h = options.heading;

  const meta: string[] = [timeHtml(call.madeAt)];
  if (repo) meta.push(escapeHtml(repoLabel(repo)));
  if (options.ticketLinks) {
    const onlyThis = filterHref(options.filter ?? {}, { ticketId: call.ticketId });
    meta.push(
      `<a href="${escapeHtml(ticketPath(call.ticketId))}">ticket ${call.ticketId}</a> (<a href="${escapeHtml(onlyThis)}">only its calls</a>)`,
    );
  }
  if (call.stateChange) meta.push(`${escapeHtml(call.stateChange.from)} → ${escapeHtml(call.stateChange.to)}`);
  else meta.push(`<span class="muted">state unchanged</span>`);

  const rows: [string, string][] = [
    ["Grounds", renderGrounds(call, context, repo)],
    ["Checks", renderResult(call.checks)],
    ["Challenge", renderResult(call.challenge)],
    ["Links", renderLinks(call, context, repo, ticket)],
    ["Model runs", renderModelRuns(call.modelRuns)],
  ];

  return `<article class="call" id="call-${call.id}">
<${h}>Call ${call.id}: ${escapeHtml(kindLabel(call.kind))}</${h}>
<p class="muted">${meta.join(" · ")}</p>
<p class="reason">${escapeHtml(call.reason)}</p>
<dl>
${rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${value}</dd>`).join("\n")}
</dl>
${renderInputs(call)}
${call.detail === null ? "" : `<details><summary>What it decided</summary>\n${preJson(call.detail)}\n</details>`}
</article>`;
}

/** What the call rests on: its citation with permalinks, the answer it cites, or "no contradiction found". */
function renderGrounds(call: CallRecord, context: CallContext, repo: RepoRecord | null): string {
  const parts: string[] = [];
  const citations = citationsOf(call);
  for (const citation of citations) parts.push(renderCitation(citation, repo));
  if (call.answerId !== null) {
    const answer = context.answer(call.ticketId, call.answerId);
    parts.push(
      answer
        ? `<p>Cites the answer ${escapeHtml(answerSummary(answer))}, given by ${escapeHtml(answer.answeredBy)} at ${timeHtml(answer.answeredAt)}.</p>`
        : `<p>Cites answer ${call.answerId}.</p>`,
    );
  }
  if (call.noContradictionFound) parts.push("<p>No contradiction found: no vision line opposes the ticket.</p>");
  return parts.length === 0 ? `<span class="muted">no citation</span>` : parts.join("\n");
}

/** A cited line: its exact text, and its heading and line number when recorded. */
interface ShownLine {
  text: string;
  heading: string | null;
  lineNumber: number | null;
}

interface ShownCitation {
  commit: string;
  lines: ShownLine[];
}

/**
 * The call's citations: the citation it records, or for a verdict the
 * passages its output cites. A citation is read in either recorded shape: a
 * commit with whole lines carrying their heading and line number (spec §4),
 * or a vision sha with the lines' text alone.
 */
function citationsOf(call: CallRecord): ShownCitation[] {
  const recorded = shownCitation(call.citation);
  if (recorded) return [recorded];
  const detail = call.detail as { citations?: unknown; vision_sha?: unknown } | null;
  if (detail === null || typeof detail !== "object" || !Array.isArray(detail.citations) || typeof detail.vision_sha !== "string") {
    return [];
  }
  const commit = detail.vision_sha;
  return detail.citations.flatMap((passage: unknown) => {
    const shown = shownCitation({ commit, lines: (passage as { lines?: unknown })?.lines });
    return shown ? [shown] : [];
  });
}

function shownCitation(value: unknown): ShownCitation | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { commit?: unknown; visionSha?: unknown; lines?: unknown };
  const commit = typeof raw.commit === "string" ? raw.commit : typeof raw.visionSha === "string" ? raw.visionSha : null;
  if (commit === null || !Array.isArray(raw.lines)) return null;
  const lines = raw.lines.flatMap((line: unknown): ShownLine[] => {
    if (typeof line === "string") return [{ text: line, heading: null, lineNumber: null }];
    if (line === null || typeof line !== "object") return [];
    const l = line as { text?: unknown; heading?: unknown; lineNumber?: unknown };
    if (typeof l.text !== "string") return [];
    return [
      {
        text: l.text,
        heading: typeof l.heading === "string" ? l.heading : null,
        lineNumber: typeof l.lineNumber === "number" && Number.isSafeInteger(l.lineNumber) && l.lineNumber > 0 ? l.lineNumber : null,
      },
    ];
  });
  return lines.length === 0 ? null : { commit, lines };
}

/**
 * A citation's lines, each linked to VISION.md at the citation's commit: at
 * its line when its line number was recorded, else to the file at that commit.
 */
function renderCitation(citation: ShownCitation, repo: RepoRecord | null): string {
  const items = citation.lines.map((line) => {
    const quote = `“${escapeHtml(line.text)}”`;
    const heading = line.heading === null ? "" : ` <span class="muted">under ${escapeHtml(line.heading)}</span>`;
    if (repo === null) return `<li>${quote}${heading}</li>`;
    const href =
      line.lineNumber === null ? visionFileUrl(repo, citation.commit) : visionPermalink(repo, citation.commit, line.lineNumber);
    return `<li><a href="${escapeHtml(href)}">${quote}</a>${heading}</li>`;
  });
  return `<p>Cites ${escapeHtml(VISION_PATH)} at <code>${escapeHtml(citation.commit.slice(0, 12))}</code>:</p>\n<ul class="citation">\n${items.join("\n")}\n</ul>`;
}

/** VISION.md as it was at a commit. */
function visionFileUrl(repo: Pick<RepoRecord, "forge" | "host" | "path">, commit: string): string {
  const blob = repo.forge === "github" ? "blob" : "-/blob";
  return `https://${repo.host}/${repo.path}/${blob}/${commit}/${VISION_PATH}`;
}

/** A mechanical check or challenge result, exactly as recorded. */
function renderResult(value: unknown): string {
  return value === null || value === undefined ? `<span class="muted">none recorded</span>` : preJson(value);
}

/** The issue, the PRs the call wrote to, and the comments it posted. */
function renderLinks(call: CallRecord, context: CallContext, repo: RepoRecord | null, ticket: TicketRecord | null): string {
  if (repo === null || ticket === null) return `<span class="muted">none</span>`;
  const links = [`<a href="${escapeHtml(issueUrl(repo, ticket.issueNumber))}">issue #${ticket.issueNumber}</a>`];
  const pulls = [...new Set(context.store.forgeWritesForCall(call.id).filter((w) => w.target === "pr").map((w) => w.number))];
  for (const number of pulls) {
    links.push(`<a href="${escapeHtml(pullRequestUrl(repo, number))}">${escapeHtml(pullRequestName(repo, number))}</a>`);
  }
  for (const comment of call.postedComments) {
    links.push(`<a href="${escapeHtml(comment.commentUrl)}">the comment it posted</a>`);
  }
  return links.join(" · ");
}

function renderModelRuns(runs: readonly ModelRunRecord[]): string {
  if (runs.length === 0) return `<span class="muted">none</span>`;
  const items = runs.map(
    (run) =>
      `<li><a href="${escapeHtml(modelRunPath(run.id))}">${escapeHtml(run.purpose)} run: input and output</a> <span class="muted">${escapeHtml(runFacts(run))}</span></li>`,
  );
  return `<ul class="runs">\n${items.join("\n")}\n</ul>`;
}

function runFacts(run: ModelRunRecord): string {
  return `${run.model}, ${(run.durationMs / 1000).toFixed(1)} s, about $${run.estimatedCostUsd.toFixed(2)}`;
}

/** The inputs the call judged, exactly as read (ADR-0009). */
function renderInputs(call: CallRecord): string {
  const inputs = call.inputs;
  if (inputs === null) return "";
  const rows: string[] = [];
  if (inputs.issueTitle != null) rows.push(`<dt>Issue title</dt><dd>${escapeHtml(inputs.issueTitle)}</dd>`);
  if (inputs.issueBody != null) rows.push(`<dt>Issue body</dt><dd><pre>${escapeHtml(inputs.issueBody)}</pre></dd>`);
  if (inputs.visionSha != null) rows.push(`<dt>Vision sha</dt><dd><code>${escapeHtml(inputs.visionSha)}</code></dd>`);
  if (inputs.pins != null) rows.push(`<dt>Pins</dt><dd>${preJson(inputs.pins)}</dd>`);
  if (inputs.settingsVersionId != null) rows.push(`<dt>Settings version</dt><dd>record ${inputs.settingsVersionId}</dd>`);
  if (inputs.prHeadSha != null) rows.push(`<dt>PR head sha</dt><dd><code>${escapeHtml(inputs.prHeadSha)}</code></dd>`);
  return `<details><summary>Inputs it judged</summary>\n<dl>\n${rows.join("\n")}\n</dl>\n</details>`;
}

/** An answer in a few words: the option chosen, the owner's own words, or "don't go ahead". */
export function answerSummary(answer: AnswerRecord): string {
  switch (answer.shape) {
    case "option":
      return `“option ${answer.optionId ?? ""}”`;
    case "own-words":
      return `“${answer.text ?? ""}”`;
    case "dont-go-ahead":
      return "“don't go ahead”";
  }
}

function preJson(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function modelRunView(store: Store, request: PageRequest): Reply {
  const id = recordId(request.url.searchParams.get("id"));
  const run = id === null ? null : store.getModelRun(id);
  if (run === null) return missing(request, "Model run", "entail has no model run with this id.");
  const call = store.getCall(run.callId)!;
  const facts: [string, string][] = [
    ["Call", `<a href="${escapeHtml(callPath(call))}">call ${call.id}: ${escapeHtml(kindLabel(call.kind))}</a>`],
    ["Ticket", `<a href="${escapeHtml(ticketPath(call.ticketId))}">ticket ${call.ticketId}</a>`],
    ["Purpose", escapeHtml(run.purpose)],
    ["Model", escapeHtml(run.model)],
    ["Prompt version", escapeHtml(run.promptVersion)],
    ["Session id", run.sessionId === null ? `<span class="muted">none</span>` : `<code>${escapeHtml(run.sessionId)}</code>`],
    ["Started", timeHtml(run.startedAt)],
    ["Duration", `${(run.durationMs / 1000).toFixed(1)} s`],
    ["Estimated cost", `$${run.estimatedCostUsd.toFixed(4)}`],
  ];
  const body = `<h1>Model run ${run.id}: ${escapeHtml(run.purpose)}</h1>
<dl>
${facts.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${value}</dd>`).join("\n")}
</dl>
<h2>Input</h2>
<pre>${escapeHtml(run.input)}</pre>
<h2>Output</h2>
<pre>${escapeHtml(prettyOutput(run.output))}</pre>`;
  return { status: 200, html: renderPage(request, { title: `Model run ${run.id}`, body }) };
}

/** A run's output, indented when it is JSON, else exactly as recorded. */
function prettyOutput(output: string): string {
  try {
    return JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    return output;
  }
}

/** A positive record id from a query value, or null. */
export function recordId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function missing(request: PageRequest, title: string, text: string): Reply {
  return {
    status: 404,
    html: renderPage(request, { title, body: `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(text)}</p>\n<p><a href="${CALLS_PATH}">Every call</a></p>` }),
  };
}
