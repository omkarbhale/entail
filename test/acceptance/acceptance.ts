#!/usr/bin/env node
// MVP-1's acceptance test (ADR-0010, MVP-1 spec Testing Decisions): 3 full
// runs on the GitHub fixture repo and 1 on gitlab.com, each from a reset
// fixture and a fresh entail with the real model runner, restarted once in
// the middle; after each run, pass checks 1–9 against the forge and entail's
// store; then the passing rule across runs. It prints a per-run, per-ticket
// report with model runs and estimated cost, and writes it with every run's
// evidence to the output directory.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createAudit } from "./audit.ts";
import { BoardDriver } from "./board-driver.ts";
import { checkRun, judge, type Plan, type RunReport } from "./checks.ts";
import { DEFAULT_BOARD_PORT, EntailProcess, OwnerPages } from "./entail.ts";
import {
  allComments,
  callIdsOnPage,
  readNotices,
  readRecords,
  readStore,
  readVisions,
  visionShasNamed,
  type RestartRecord,
  type RunEvidence,
  type StoreSnapshot,
} from "./evidence.ts";
import { ScriptedExecutor, Workspace } from "./executor.ts";
import { DEFAULT_BRANCH, FIXTURE_ISSUES, FIXTURE_REPO_NAME, startingTree, type TicketId } from "./fixture.ts";
import { createForge, type ForgeKind } from "./forge.ts";
import { renderReport, renderRun } from "./report.ts";
import { fileFixtureIssues, resetFixture, type HarnessEvent, type Log } from "./reset.ts";

const USAGE = `Usage: npm run acceptance -- [options]

Runs MVP-1's acceptance test: resets each fixture repo, starts a fresh entail
with the real model runner, enrolls the repo with the fixture's settings,
files T1–T13, plays the executor and the owner, restarts entail once midway,
then runs pass checks 1–9 and the passing rule across runs.

Options:
  --forge <github|gitlab|both>  Which forges to run on (default: both)
  --github-runs <n>             Runs on GitHub (default: 3)
  --gitlab-runs <n>             Runs on gitlab.com (default: 1)
  --github-repo <owner/name>    GitHub fixture repo (default: <you>/${FIXTURE_REPO_NAME})
  --gitlab-repo <path>          gitlab.com fixture repo (default: <you>/${FIXTURE_REPO_NAME})
  --out <dir>                   Where reports, evidence and entail's data go
                                (default: a new directory under the system temp dir)
  --owner-name <name>           The display name entail answers and comments as (default: your forge login)
  --poll-interval <seconds>     entail's poll interval (default: 45; each pass re-reads every landing PR,
                                and the forge's API budget is per account)
  --model-run-limit <n>         entail's limit on model runs at once (default: 3)
  --executor-interval <seconds> Seconds between the scripted executor's passes (default: 60; each
                                pass reads every open PR, and the forge's API budget is per account)
  --port <n>                    The board port of the entail each run starts (default: ${DEFAULT_BOARD_PORT}); another
                                port lets this test run beside one holding ${DEFAULT_BOARD_PORT}
  --max-minutes <n>             Time limit for one run (default: 180)
  --stall-minutes <n>           End a run that has not settled once no ticket has changed state
                                for this long after the restart (default: 30)
  --restart-after <minutes>     Restart entail by then even if no ticket is landing yet (default: 30)
  --recheck <dir>               Run the pass checks again on the evidence saved in <dir>, without running
  --verbose                     Print every harness event

Exit status: 0 when the test passed on both forges, 1 when it failed, 3 when
it passed on GitHub and the gitlab.com run is pending (glab missing or
logged out), 4 when runs are missing.
`;

const options = {
  forge: { type: "string", default: "both" },
  "github-runs": { type: "string", default: "3" },
  "gitlab-runs": { type: "string", default: "1" },
  "github-repo": { type: "string" },
  "gitlab-repo": { type: "string" },
  out: { type: "string" },
  "owner-name": { type: "string" },
  "poll-interval": { type: "string", default: "45" },
  "model-run-limit": { type: "string", default: "3" },
  "executor-interval": { type: "string", default: "60" },
  "max-minutes": { type: "string", default: "180" },
  "stall-minutes": { type: "string", default: "30" },
  port: { type: "string", default: String(DEFAULT_BOARD_PORT) },
  "restart-after": { type: "string", default: "30" },
  recheck: { type: "string" },
  verbose: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options }>>["values"];

const HOSTS: Record<ForgeKind, string> = { github: "github.com", gitlab: "gitlab.com" };
const say = (line: string) => process.stdout.write(`${line}\n`);

/** Whether a forge's CLI is installed and logged in; the reason when not. */
function cliProblem(kind: ForgeKind): string | undefined {
  const cli = kind === "github" ? "gh" : "glab";
  const result = spawnSync(cli, ["auth", "status", "--hostname", HOSTS[kind]], { encoding: "utf8" });
  if (result.error) return `${cli} is not installed`;
  if (result.status !== 0) return `${cli} is not logged in to ${HOSTS[kind]}`;
  return undefined;
}

interface RunContext {
  kind: ForgeKind;
  run: number;
  path: string;
  out: string;
  values: Values;
  ownerName: string;
}

/** Runs `pass` every `seconds` until aborted, logging a failed pass and going on. */
async function every(seconds: number, signal: AbortSignal, log: Log, name: string, pass: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try {
      await pass();
    } catch (error) {
      log({ event: `${name}-pass-failed`, error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(seconds * 1000, undefined, { signal }).catch(() => {});
  }
}

const FINAL = new Set(["merged", "cancelled", "declined"]);

/** Tickets by their fixture id, through the issue numbers filed in this run. */
function ticketStates(store: StoreSnapshot, issues: Partial<Record<TicketId, number>>): Map<TicketId, string | undefined> {
  return new Map(
    FIXTURE_ISSUES.map((f) => [f.id, store.tickets.filter((t) => t.issueNumber === issues[f.id]).at(-1)?.state] as const),
  );
}

/**
 * A run has settled when every ticket is final or waits on the board for an
 * answer nobody will give (T8, or an item the board driver could not answer),
 * and every forge write entail recorded is confirmed.
 */
function isSettled(store: StoreSnapshot, issues: Partial<Record<TicketId, number>>, events: readonly HarnessEvent[]): boolean {
  if (store.forgeWrites.some((w) => w.confirmed === null)) return false;
  const unanswerable = new Set(
    events
      .filter((e) => e.event === "left-unanswered" || e.event === "extra-item-unanswered" || (e.event === "answer-failed" && Number(e.attempt) >= 3))
      .map((e) => e.ticket as TicketId),
  );
  for (const [id, state] of ticketStates(store, issues)) {
    if (state === undefined) return false;
    if (FINAL.has(state)) continue;
    if (state === "on-the-board" && (id === "T8" || unanswerable.has(id))) continue;
    return false;
  }
  return true;
}

/**
 * Midway: some ticket is landing (its PR is open and being checked) and
 * some board item has been answered, or the fallback time has come.
 */
function isMidway(store: StoreSnapshot, minutes: number, fallback: number): boolean {
  const landing = store.tickets.some((t) => t.state === "landing");
  const answered = store.boardItems.some((b) => b.answer !== null);
  return (landing && answered) || minutes >= fallback;
}

function summary(states: Map<TicketId, string | undefined>): string {
  const counts = new Map<string, number>();
  for (const state of states.values()) counts.set(state ?? "not taken in", (counts.get(state ?? "not taken in") ?? 0) + 1);
  return [...counts].map(([state, n]) => `${state} ${n}`).join(", ");
}

/** One full run on one forge: reset, enroll, play with a restart midway, then collect the evidence. */
async function acceptanceRun(ctx: RunContext): Promise<{ evidence: RunEvidence; report: RunReport }> {
  const { kind, run, values } = ctx;
  const name = `${kind}-run-${run}`;
  const directory = join(ctx.out, name);
  mkdirSync(directory, { recursive: true });
  const events: HarnessEvent[] = [];
  const log: Log = (event) => {
    const line = { at: new Date().toISOString(), ...event };
    events.push(line);
    appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify(line)}\n`);
    if (values.verbose) say(`[${name}] ${JSON.stringify(line)}`);
  };
  const tag = (line: string) => say(`[${name}] ${line}`);

  const forge = createForge({ kind, host: HOSTS[kind], path: ctx.path });
  const audit = createAudit({ kind, host: HOSTS[kind], path: ctx.path });
  const startedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  tag(`resetting ${kind} ${ctx.path}`);
  await resetFixture(forge, log, { fileIssues: false });

  const entail = new EntailProcess({ dataHome: join(directory, "data-home"), logFile: join(directory, "entail.log"), port: Number(values.port) });
  const issueNumbers: Partial<Record<TicketId, number>> = {};
  let restart: RestartRecord | null = null;
  let settled = false;
  let callsPage: string | null = null;
  await entail.start();
  try {
    const owner = new OwnerPages(entail.origin);
    await owner.saveGlobalSettings({
      ownerName: ctx.ownerName,
      pollIntervalSeconds: Number(values["poll-interval"]),
      modelRunLimit: Number(values["model-run-limit"]),
    });
    tag("enrolling with the fixture's settings");
    await owner.enroll({ forge: kind, host: HOSTS[kind], path: ctx.path });
    await owner.pin(ctx.path);
    log({ event: "enrolled", repo: ctx.path });
    for (const { id, number } of await fileFixtureIssues(forge)) issueNumbers[id] = number;
    log({ event: "issues-filed", issues: issueNumbers });
    tag(`filed T1–T13 as issues ${Object.values(issueNumbers).join(", ")}`);

    const stop = new AbortController();
    const executor = new ScriptedExecutor({
      forge,
      workspace: new Workspace(forge, join(ctx.out, "executor-work")),
      log: (event) => log({ ...event, forge: kind }),
    });
    const driver = new BoardDriver({ boardUrl: `${entail.origin}/`, forges: [forge], log });
    const playing = Promise.all([
      every(Number(values["executor-interval"]), stop.signal, log, "executor", () => executor.pass()),
      every(5, stop.signal, log, "board-driver", () => driver.pass()),
    ]);

    const began = Date.now();
    const deadline = began + Number(values["max-minutes"]) * 60_000;
    let quiet = 0;
    let lastSummary = "";
    let lastStates = "";
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      await sleep(20_000);
      const store = readStore(entail.dataDirectory);
      const minutes = (Date.now() - began) / 60_000;
      const states = ticketStates(store, issueNumbers);
      const line = summary(states);
      if (line !== lastSummary) tag(`${minutes.toFixed(0)} min: ${line}`);
      lastSummary = line;
      const statesNow = JSON.stringify([...states]);
      if (statesNow !== lastStates) {
        lastStates = statesNow;
        lastChange = Date.now();
      }
      if (restart === null && isMidway(store, minutes, Number(values["restart-after"]))) {
        const ticketsBefore = store.tickets;
        const stoppedAt = new Date().toISOString();
        tag("restarting entail midway");
        log({ event: "restart-stopping", tickets: ticketsBefore.length });
        await entail.stop();
        await sleep(3000);
        await entail.start();
        restart = { stoppedAt, startedAt: new Date().toISOString(), ticketsBefore };
        log({ event: "restart-started" });
        continue;
      }
      if (restart !== null && isSettled(store, issueNumbers, events)) {
        quiet += 1;
        if (quiet >= 2) {
          settled = true;
          break;
        }
      } else quiet = 0;
      // A ticket no executor can move (such as a landing check that can never pass) would hold the run to its time limit.
      if (restart !== null && Date.now() - lastChange >= Number(values["stall-minutes"]) * 60_000) {
        tag(`stalled: no ticket changed state for ${values["stall-minutes"]} minutes`);
        log({ event: "run-stalled", minutes: Number(values["stall-minutes"]) });
        break;
      }
    }
    if (!settled) tag("ended before every ticket settled");
    try {
      const response = await fetch(`${entail.origin}/calls`);
      callsPage = response.ok ? await response.text() : null;
    } catch {
      callsPage = null;
    }
    stop.abort();
    await playing;
  } finally {
    await entail.stop();
  }
  const finishedAt = new Date().toISOString();

  tag("reading the forge and entail's store");
  const store = readStore(entail.dataDirectory);
  const numbers = Object.values(issueNumbers);
  const issues = await audit.issues(numbers);
  const pullRequests = await audit.pullRequests(startedAt);
  const visionAt = await readVisions(audit, visionShasNamed(store, allComments(issues, pullRequests)));
  const evidence: RunEvidence = {
    forge: kind,
    repo: ctx.path,
    ownerName: ctx.ownerName,
    boardOrigin: entail.origin,
    issueNumbers,
    startingVision: startingTree().get("VISION.md")!,
    finalVision: await audit.fileAt("VISION.md", await audit.branchHead(DEFAULT_BRANCH)),
    visionAt,
    issues,
    pullRequests,
    store,
    notices: readNotices(entail.dataDirectory),
    callsPageIds: callsPage === null ? null : callIdsOnPage(callsPage),
    records: readRecords(entail.dataDirectory),
    events,
    restart,
  };
  const meta = { run, startedAt, finishedAt, settled };
  writeFileSync(join(directory, "evidence.json"), `${JSON.stringify({ meta, evidence }, null, 2)}\n`);
  const report = checkRun(evidence, meta);
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return { evidence, report };
}

/** Runs the pass checks again on every run's saved evidence. */
function recheck(directory: string): RunReport[] {
  const reports: RunReport[] = [];
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name, "evidence.json");
    if (!existsSync(file)) continue;
    const { meta, evidence } = JSON.parse(readFileSync(file, "utf8")) as { meta: Parameters<typeof checkRun>[1]; evidence: RunEvidence };
    reports.push(checkRun(evidence, meta));
  }
  return reports;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const kinds: ForgeKind[] = values.forge === "both" ? ["github", "gitlab"] : [values.forge as ForgeKind];
  if (!kinds.every((k) => k === "github" || k === "gitlab")) throw new Error(`unknown forge: ${values.forge}`);
  const plan: Plan = {
    githubRuns: kinds.includes("github") ? Number(values["github-runs"]) : 0,
    gitlabRuns: kinds.includes("gitlab") ? Number(values["gitlab-runs"]) : 0,
  };

  let reports: RunReport[];
  let out: string;
  if (values.recheck) {
    out = values.recheck;
    reports = recheck(out);
    const saved = join(out, "plan.json");
    if (existsSync(saved)) Object.assign(plan, JSON.parse(readFileSync(saved, "utf8")));
  } else {
    out = values.out ?? join(tmpdir(), `entail-acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(out, { recursive: true });
    say(`acceptance output: ${out}`);
    reports = [];
    for (const kind of kinds) {
      const runs = kind === "github" ? plan.githubRuns : plan.gitlabRuns;
      if (runs === 0) continue;
      const problem = cliProblem(kind);
      if (problem !== undefined) {
        if (kind === "gitlab") {
          plan.gitlabPending = problem;
          say(`gitlab.com runs pending: ${problem}`);
          continue;
        }
        throw new Error(problem);
      }
      let path = kind === "github" ? values["github-repo"] : values["gitlab-repo"];
      const me = await createForge({ kind, host: HOSTS[kind], path: "" }).whoami();
      path ??= `${me.login}/${FIXTURE_REPO_NAME}`;
      for (let run = 1; run <= runs; run += 1) {
        const { report } = await acceptanceRun({ kind, run, path, out, values, ownerName: values["owner-name"] ?? me.login });
        reports.push(report);
        say(renderRun(report));
      }
    }
    writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  }

  const verdict = judge(reports, plan);
  const text = renderReport(verdict, reports);
  writeFileSync(join(out, "report.md"), `${text}\n`);
  writeFileSync(join(out, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  say(text);
  say(`\nreport: ${join(out, "report.md")}`);
  if (verdict.passed) return 0;
  if (verdict.status === "failed") return 1;
  if (verdict.github === "passed" && verdict.gitlab === "pending") return 3;
  return 4;
}

// Exits explicitly: idle keep-alive connections to entail's pages and the forge would otherwise hold the process open.
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`acceptance: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
