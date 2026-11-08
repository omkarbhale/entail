import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { readStatusFile, shownTime, type HealthCondition, type RepoStatus } from "./health.ts";
import { holderIsRunning, readLock, type LockHolder } from "./lock.ts";
import { OPERATIONAL_LOG_FILE } from "./operational-log.ts";
import { readRecordsPushState, type RecordsPushState } from "./records-repo.ts";

/** How many warning lines from the operational log `entail status` shows. */
export const RECENT_WARNINGS = 10;
/** How much of the end of the operational log is read for them. */
const LOG_TAIL_BYTES = 256 * 1024;

/** `entail status`'s exit codes (spec §16). */
export const STATUS_EXIT = { healthy: 0, haltedOrWarned: 1, notRunning: 2 } as const;

/** One halt or warning as `entail status` shows it. */
export interface StatusCondition {
  key: string;
  wrong: string;
  stops: string;
  since: string;
  clears: string;
}

/** What `entail status` prints, and `--json` prints as JSON (spec §16, ADR-0019). It lists no tickets. */
export interface StatusReport {
  running: boolean;
  /** From the lock: the copy running now, or the one that left its lock behind. */
  pid: number | null;
  startedAt: string | null;
  /** A lock left by a process that no longer exists: entail stopped unexpectedly. */
  stoppedUnexpectedly: boolean;
  /** When the status file was last written, or null when there is none. */
  statusWrittenAt: string | null;
  lastPass: string | null;
  halts: StatusCondition[];
  warnings: StatusCondition[];
  /** Standing lines never shown on the strip, such as no records remote being set. */
  standing: string[];
  repos: RepoStatus[];
  records: RecordsPushState;
  /** The last warning and error lines of the operational log, oldest first. */
  recentWarnings: Record<string, unknown>[];
  exitCode: number;
}

export interface StatusOptions {
  /** Whether the lock's holder is still running; the real process table by default. */
  isAlive?: (holder: LockHolder) => boolean;
}

/**
 * Reads entail's status from the data directory, whether or not entail is
 * running: the lock says whether it runs, and the status file the running
 * process rewrites on every pass says the rest (spec §16, ADR-0019). It opens
 * no store and asks the running process nothing.
 *
 * Exits 0 when entail is running with no halt or warning, 1 when something is
 * halted or warned, and 2 when entail is not running.
 */
export function readStatus(dataDirectory: string, options: StatusOptions = {}): StatusReport {
  const isAlive = options.isAlive ?? holderIsRunning;
  const lock = readLock(dataDirectory);
  const running = lock !== null && isAlive(lock);
  const status = readStatusFile(dataDirectory);
  // A status file left by an earlier copy says nothing about the one running now, but it is what is known.
  const conditions = status?.conditions ?? [];
  const halts = conditions.filter((c) => c.kind === "halt").map(shown);
  const warnings = conditions.filter((c) => c.kind === "warning").map(shown);
  const exitCode = !running ? STATUS_EXIT.notRunning : halts.length + warnings.length > 0 ? STATUS_EXIT.haltedOrWarned : STATUS_EXIT.healthy;
  return {
    running,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
    stoppedUnexpectedly: lock !== null && !running,
    statusWrittenAt: status?.writtenAt ?? null,
    lastPass: status?.lastPass ?? null,
    halts,
    warnings,
    standing: status?.standing ?? [],
    repos: status?.repos ?? [],
    records: readRecordsPushState(dataDirectory),
    recentWarnings: recentWarnings(dataDirectory, RECENT_WARNINGS),
    exitCode,
  };
}

/** The report as the terminal shows it. */
export function statusText(report: StatusReport): string {
  const lines: string[] = [];
  if (report.running) {
    lines.push(`entail is running: pid ${report.pid}, started ${shownTime(report.startedAt!)}.`);
  } else if (report.stoppedUnexpectedly) {
    lines.push(`entail is not running. It stopped unexpectedly: pid ${report.pid}, started ${shownTime(report.startedAt!)}, left its lock behind.`);
  } else {
    lines.push("entail is not running.");
  }
  if (report.statusWrittenAt === null) {
    lines.push("No status has been written yet: entail has not run here.");
  } else {
    if (!report.running) lines.push(`What follows is as of ${shownTime(report.statusWrittenAt)}, when entail last wrote its status.`);
    lines.push(`Last pass: ${report.lastPass === null ? "none yet" : shownTime(report.lastPass)}.`);
  }
  lines.push("");
  if (report.halts.length + report.warnings.length === 0) {
    lines.push("No halts or warnings.");
  } else {
    for (const [heading, conditions] of [
      ["Halted", report.halts],
      ["Warnings", report.warnings],
    ] as const) {
      if (conditions.length === 0) continue;
      lines.push(`${heading}:`);
      for (const c of conditions) lines.push(`  - ${c.wrong}. ${c.stops} since ${shownTime(c.since)}. ${c.clears}.`);
    }
  }
  for (const line of report.standing) lines.push(line);
  lines.push("");
  if (report.repos.length === 0) {
    lines.push("Repos: none enrolled.");
  } else {
    lines.push("Repos:");
    for (const repo of report.repos) {
      const poll = repo.lastSuccessfulPoll === null ? "not polled yet" : `last successful poll ${shownTime(repo.lastSuccessfulPoll)}`;
      lines.push(`  - ${repo.path} on ${repo.host}: ${repo.state}; ${poll}.`);
    }
  }
  const { lastSuccess, lastFailure } = report.records;
  lines.push(
    lastSuccess === null
      ? "Records repo: no push has succeeded yet."
      : `Records repo: last push succeeded ${shownTime(lastSuccess.at)}, to ${lastSuccess.remote}.`,
  );
  if (lastFailure !== null) lines.push(`Records repo: the last push failed ${shownTime(lastFailure.at)}: ${lastFailure.error.replace(/\s+/g, " ").trim()}`);
  lines.push("");
  if (report.recentWarnings.length === 0) {
    lines.push("No recent warnings in the operational log.");
  } else {
    lines.push("Recent warnings in the operational log:");
    for (const entry of report.recentWarnings) {
      const { time, level, event, ...fields } = entry;
      const rest = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
      lines.push(`  ${String(time)} ${String(level)} ${String(event)}${rest}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function shown(condition: HealthCondition): StatusCondition {
  return { key: condition.key, wrong: condition.wrong, stops: condition.stops, since: condition.since, clears: condition.clears };
}

/** The last `count` warning and error lines of the operational log's current file, oldest first. */
export function recentWarnings(dataDirectory: string, count: number): Record<string, unknown>[] {
  let text: string;
  try {
    text = tail(join(dataDirectory, OPERATIONAL_LOG_FILE), LOG_TAIL_BYTES);
  } catch {
    return [];
  }
  const found: Record<string, unknown>[] = [];
  const lines = text.split("\n");
  for (let n = lines.length - 1; n >= 0 && found.length < count; n--) {
    try {
      const entry: unknown = JSON.parse(lines[n]!);
      if (typeof entry === "object" && entry !== null && ((entry as { level?: unknown }).level === "warn" || (entry as { level?: unknown }).level === "error")) {
        found.push(entry as Record<string, unknown>);
      }
    } catch {
      // a line cut by the tail, or not JSON: skipped
    }
  }
  return found.reverse();
}

function tail(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
