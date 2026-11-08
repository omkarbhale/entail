// What one acceptance run leaves behind for the pass checks: the forge as the
// audit reads it, entail's store read row by row, the notices the `file`
// connector wrote, the Calls page, the records repo and the harness's own
// events. Everything here is read only; nothing is written to the store.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditedIssue, AuditedPullRequest, ForgeAudit } from "./audit.ts";
import type { TicketId } from "./fixture.ts";
import type { ForgeKind } from "./forge.ts";
import type { HarnessEvent } from "./reset.ts";

export interface StoreTicket {
  id: number;
  issueNumber: number;
  predecessorId: number | null;
  takenInAt: string;
  state: string;
}

export interface StoreModelRun {
  id: number;
  callId: number;
  purpose: string;
  model: string;
  durationMs: number;
  estimatedCostUsd: number;
}

export interface StoreInputs {
  issueTitle: string | null;
  issueBody: string | null;
  visionSha: string | null;
  pins: unknown;
  settingsVersionId: number | null;
  prHeadSha: string | null;
}

export interface StoreCall {
  id: number;
  ticketId: number;
  madeAt: string;
  kind: string;
  reason: string;
  citation: { visionSha: string; lines: string[] } | null;
  answerId: number | null;
  noContradictionFound: boolean;
  checks: unknown;
  challenge: unknown;
  inputs: StoreInputs;
  detail: any;
  stateFrom: string | null;
  stateTo: string | null;
  modelRuns: StoreModelRun[];
}

export interface StoreBoardItem {
  id: number;
  ticketId: number;
  callId: number;
  raisedAt: string;
  decision: string;
  whyRaised: string;
  snapshot: any;
  answer: { id: number; answeredAt: string; answeredBy: string; shape: string; text: string | null; optionId: string | null } | null;
  withdrawn: { callId: number; at: string; reason: string } | null;
}

export interface StoreForgeWrite {
  id: number;
  ticketId: number | null;
  callId: number | null;
  kind: "comment" | "label" | "close" | "merge";
  target: "issue" | "pr";
  number: number;
  payload: any;
  recordedAt: string;
  confirmed: { at: string; commentId: string | null; commentUrl: string | null; result: unknown } | null;
}

export interface StoreSnapshot {
  tickets: StoreTicket[];
  calls: StoreCall[];
  boardItems: StoreBoardItem[];
  forgeWrites: StoreForgeWrite[];
  visionChanges: { id: number; commitSha: string; added: string[]; removed: string[] }[];
  visionLineOrigins: { line: string; origin: string; source: string; commitSha: string }[];
  enrollmentModelRuns: { purpose: string; estimatedCostUsd: number | null; failed: boolean }[];
}

export interface Notice {
  time: string;
  kind: string;
  text: string;
  repo: string | null;
  link: string;
}

export interface RecordsCommit {
  sha: string;
  committedAt: string;
  message: string;
  /** The answer ids `tables/answers.jsonl` holds at this commit. */
  answerIds: number[];
}

export interface RestartRecord {
  stoppedAt: string;
  startedAt: string;
  /** The tickets the store held just before the stop. */
  ticketsBefore: StoreTicket[];
}

/** Everything one run's pass checks read. */
export interface RunEvidence {
  forge: ForgeKind;
  repo: string;
  ownerName: string;
  /** The board's origin, which board links name. */
  boardOrigin: string;
  /** Each fixture ticket's issue number in this run. */
  issueNumbers: Partial<Record<TicketId, number>>;
  /** VISION.md as the fixture starts it. */
  startingVision: string;
  /** VISION.md at the default branch's head after the run. */
  finalVision: string | undefined;
  /** VISION.md at every commit a citation, vision check or permalink names. */
  visionAt: Record<string, string | undefined>;
  issues: AuditedIssue[];
  pullRequests: AuditedPullRequest[];
  store: StoreSnapshot;
  notices: Notice[];
  /** The call ids the Calls page lists, or null when it could not be read. */
  callsPageIds: number[] | null;
  records: RecordsCommit[];
  events: HarnessEvent[];
  restart: RestartRecord | null;
}

const json = (value: unknown): any => (typeof value === "string" ? JSON.parse(value) : null);

/** Reads entail's store, read only, row by row. */
export function readStore(dataDirectory: string): StoreSnapshot {
  const path = join(dataDirectory, "store.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all() as Record<string, any>[];
    const runs = all("SELECT id, call_id, purpose, model, duration_ms, estimated_cost_usd FROM model_runs ORDER BY id");
    const runsByCall = new Map<number, StoreModelRun[]>();
    for (const r of runs) {
      const list = runsByCall.get(r.call_id) ?? [];
      list.push({ id: r.id, callId: r.call_id, purpose: r.purpose, model: r.model, durationMs: r.duration_ms, estimatedCostUsd: r.estimated_cost_usd });
      runsByCall.set(r.call_id, list);
    }
    const answers = new Map(all("SELECT * FROM answers").map((a) => [a.board_item_id as number, a]));
    const withdrawals = new Map(all("SELECT * FROM board_item_withdrawals").map((w) => [w.board_item_id as number, w]));
    const confirmations = new Map(all("SELECT * FROM forge_write_confirmations").map((c) => [c.intent_id as number, c]));
    return {
      tickets: all("SELECT t.*, s.state FROM tickets t JOIN ticket_states s ON s.ticket_id = t.id ORDER BY t.id").map((t) => ({
        id: t.id,
        issueNumber: t.issue_number,
        predecessorId: t.predecessor_id,
        takenInAt: t.taken_in_at,
        state: t.state,
      })),
      calls: all("SELECT * FROM calls ORDER BY id").map((c) => ({
        id: c.id,
        ticketId: c.ticket_id,
        madeAt: c.made_at,
        kind: c.kind,
        reason: c.reason,
        citation: json(c.citation),
        answerId: c.answer_id,
        noContradictionFound: c.no_contradiction_found === 1,
        checks: json(c.checks),
        challenge: json(c.challenge),
        inputs: {
          issueTitle: c.issue_title,
          issueBody: c.issue_body,
          visionSha: c.vision_sha,
          pins: json(c.pins),
          settingsVersionId: c.settings_version_id,
          prHeadSha: c.pr_head_sha,
        },
        detail: json(c.detail),
        stateFrom: c.state_from,
        stateTo: c.state_to,
        modelRuns: runsByCall.get(c.id) ?? [],
      })),
      boardItems: all("SELECT * FROM board_items ORDER BY id").map((b) => {
        const a = answers.get(b.id);
        const w = withdrawals.get(b.id);
        return {
          id: b.id,
          ticketId: b.ticket_id,
          callId: b.call_id,
          raisedAt: b.raised_at,
          decision: b.decision,
          whyRaised: b.why_raised,
          snapshot: json(b.snapshot),
          answer: a ? { id: a.id, answeredAt: a.answered_at, answeredBy: a.answered_by, shape: a.shape, text: a.text, optionId: a.option_id } : null,
          withdrawn: w ? { callId: w.call_id, at: w.withdrawn_at, reason: w.reason } : null,
        };
      }),
      forgeWrites: all("SELECT * FROM forge_write_intents ORDER BY id").map((i) => {
        const c = confirmations.get(i.id);
        return {
          id: i.id,
          ticketId: i.ticket_id,
          callId: i.call_id,
          kind: i.kind,
          target: i.target,
          number: i.number,
          payload: json(i.payload),
          recordedAt: i.recorded_at,
          confirmed: c ? { at: c.confirmed_at, commentId: c.comment_id, commentUrl: c.comment_url, result: json(c.result) } : null,
        };
      }),
      visionChanges: all("SELECT * FROM vision_changes ORDER BY id").map((v) => ({
        id: v.id,
        commitSha: v.commit_sha,
        added: JSON.parse(v.added),
        removed: JSON.parse(v.removed),
      })),
      visionLineOrigins: all("SELECT * FROM vision_line_origins ORDER BY id").map((o) => ({
        line: o.line,
        origin: o.origin,
        source: o.source,
        commitSha: o.commit_sha,
      })),
      enrollmentModelRuns: all("SELECT * FROM enrollment_model_runs ORDER BY id").map((r) => ({
        purpose: r.purpose,
        estimatedCostUsd: r.estimated_cost_usd,
        failed: r.failure !== null,
      })),
    };
  } finally {
    db.close();
  }
}

/** The notices the `file` connector appended, one JSON object per line. */
export function readNotices(dataDirectory: string): Notice[] {
  const path = join(dataDirectory, "notices.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Notice);
}

/** The records repo's commits, newest first, with the answers each one holds. */
export function readRecords(dataDirectory: string): RecordsCommit[] {
  const directory = join(dataDirectory, "records");
  if (!existsSync(join(directory, ".git"))) return [];
  const git = (args: string[]) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  const log = git(["log", "--format=%H%x09%cI%x09%s"]);
  if (log.status !== 0) return [];
  return log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, committedAt, message] = line.split("\t") as [string, string, string];
      const answers = git(["show", `${sha}:tables/answers.jsonl`]);
      const answerIds =
        answers.status !== 0
          ? []
          : answers.stdout
              .split("\n")
              .filter((l) => l.trim() !== "")
              .map((l) => Number((JSON.parse(l) as { id: unknown }).id))
              .filter(Number.isFinite);
      return { sha, committedAt, message, answerIds };
    });
}

/** The call ids the Calls page lists, by the anchor each call carries. */
export function callIdsOnPage(html: string): number[] {
  return [...html.matchAll(/<article class="call" id="call-(\d+)"/g)].map((m) => Number(m[1]));
}

const PERMALINK = /https:\/\/[^\s)"'<>]+?\/(?:-\/)?blob\/([0-9a-f]{40})\/VISION\.md#L\d+/g;

/** Every commit the run's citations, vision checks and permalinks name, so their VISION.md can be read. */
export function visionShasNamed(store: StoreSnapshot, comments: readonly string[]): string[] {
  const shas = new Set<string>();
  for (const call of store.calls) {
    if (call.citation?.visionSha) shas.add(call.citation.visionSha);
    if (call.inputs.visionSha) shas.add(call.inputs.visionSha);
  }
  for (const body of comments) for (const m of body.matchAll(PERMALINK)) shas.add(m[1]!);
  return [...shas];
}

/** Reads VISION.md at each named commit. */
export async function readVisions(audit: ForgeAudit, shas: readonly string[]): Promise<Record<string, string | undefined>> {
  const visions: Record<string, string | undefined> = {};
  for (const sha of shas) visions[sha] = await audit.fileAt("VISION.md", sha);
  return visions;
}

/** Every comment on the run's issues and PRs. */
export function allComments(issues: readonly AuditedIssue[], prs: readonly AuditedPullRequest[]): string[] {
  return [...issues.flatMap((i) => i.comments), ...prs.flatMap((p) => p.comments)].map((c) => c.body);
}
