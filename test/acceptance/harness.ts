#!/usr/bin/env node
// The acceptance harness's command line (ADR-0010, MVP-1 spec Testing
// Decisions). Events are printed as JSON lines on standard output, and also
// appended to --events when given, for the acceptance run to read.
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { BoardDriver } from "./board-driver.ts";
import { ScriptedExecutor, Workspace } from "./executor.ts";
import { FIXTURE_REPO_NAME } from "./fixture.ts";
import { createForge, type Forge, type ForgeKind } from "./forge.ts";
import { acquireFixtureLock, refuseInsidePipeline, type LockOptions } from "./lock.ts";
import { resetFixture, setupFixture, startingStateDifferences, type HarnessEvent, type Log } from "./reset.ts";

const USAGE = `Usage: node test/acceptance/harness.ts <command> [options]

Commands:
  setup         Create the private fixture repos if they are missing, then reset them
  reset         Reset the fixture repos to tally's starting state
  check         Report what differs from the starting state (exit 1 if anything does)
  executor      Run the scripted test executor
  board-driver  Answer board items through the board form as the owner
  play          Run the executor and the board driver together

Options:
  --forge <github|gitlab|both>  Which fixture repos (default: both)
  --github-repo <owner/name>    GitHub fixture repo (default: <you>/${FIXTURE_REPO_NAME})
  --gitlab-repo <path>          gitlab.com fixture repo (default: <you>/${FIXTURE_REPO_NAME})
  --board <url>                 The board page (default: http://127.0.0.1:7419/)
  --interval <seconds>          Seconds between passes (default: 15 for the executor, 5 for the board)
  --once                        Make one pass and exit
  --work-dir <path>             Where the executor keeps its clones (default: a directory under the system temp dir)
  --events <file>               Also append every event to this JSON-lines file
  --break-lock                  Take a fixture's lock even though it is held, when its holder is gone

setup, reset, executor and play hold each fixture repo's lock while they run,
and refuse to start while another run or reset holds it. Every command but
check refuses to run inside a review pipeline (NO_MISTAKES_GATE set).
`;

const options = {
  forge: { type: "string", default: "both" },
  "github-repo": { type: "string" },
  "gitlab-repo": { type: "string" },
  board: { type: "string", default: "http://127.0.0.1:7419/" },
  interval: { type: "string" },
  once: { type: "boolean", default: false },
  "work-dir": { type: "string" },
  events: { type: "string" },
  "break-lock": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

function logger(eventsFile: string | undefined): Log {
  return (event: HarnessEvent) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    process.stdout.write(line);
    if (eventsFile) appendFileSync(eventsFile, line);
  };
}

const HOSTS: Record<ForgeKind, string> = { github: "github.com", gitlab: "gitlab.com" };

async function forges(values: Values): Promise<Forge[]> {
  const kinds: ForgeKind[] = values.forge === "both" ? ["github", "gitlab"] : [values.forge as ForgeKind];
  if (!kinds.every((kind) => kind === "github" || kind === "gitlab")) throw new Error(`unknown forge: ${values.forge}`);
  const result: Forge[] = [];
  for (const kind of kinds) {
    let path = kind === "github" ? values["github-repo"] : values["gitlab-repo"];
    if (!path) {
      const me = await createForge({ kind, host: HOSTS[kind], path: "" }).whoami();
      path = `${me.login}/${FIXTURE_REPO_NAME}`;
    }
    result.push(createForge({ kind, host: HOSTS[kind], path }));
  }
  return result;
}

async function loop(intervalSeconds: number, once: boolean, log: Log, name: string, pass: () => Promise<void>): Promise<void> {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  log({ event: `${name}-started` });
  while (!stop.signal.aborted) {
    try {
      await pass();
    } catch (error) {
      log({ event: `${name}-pass-failed`, error: error instanceof Error ? error.message : String(error) });
    }
    if (once) break;
    await sleep(intervalSeconds * 1000, undefined, { signal: stop.signal }).catch(() => {});
  }
  log({ event: `${name}-stopped` });
}

function executorLoop(values: Values, targets: Forge[], log: Log): Promise<void> {
  const workDirectory = values["work-dir"] ?? join(tmpdir(), "entail-acceptance-executor");
  const executors = targets.map(
    (forge) => new ScriptedExecutor({ forge, workspace: new Workspace(forge, workDirectory), log: (e) => log({ ...e, forge: forge.kind }) }),
  );
  return loop(Number(values.interval ?? 15), values.once, log, "executor", async () => {
    for (const executor of executors) await executor.pass();
  });
}

function boardLoop(values: Values, targets: Forge[], log: Log): Promise<void> {
  const driver = new BoardDriver({ boardUrl: values.board, forges: targets, log });
  return loop(Number(values.interval ?? 5), values.once, log, "board-driver", () => driver.pass());
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const [command] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (command !== "check") refuseInsidePipeline(`harness ${command}`);
  const log = logger(values.events);
  const targets = await forges(values);
  const lock: LockOptions = { breakStale: values["break-lock"] };
  // The executor writes to the fixture repos for as long as it runs: it holds their locks throughout.
  if (command === "executor" || command === "play") for (const forge of targets) acquireFixtureLock(forge, lock);
  switch (command) {
    case "setup":
      for (const forge of targets) await setupFixture(forge, log, { lock });
      return 0;
    case "reset":
      for (const forge of targets) await resetFixture(forge, log, { lock });
      return 0;
    case "check": {
      let clean = true;
      for (const forge of targets) {
        const differences = await startingStateDifferences(forge);
        log({ event: "starting-state", forge: forge.kind, repo: forge.path, differences });
        clean &&= differences.length === 0;
      }
      return clean ? 0 : 1;
    }
    case "executor":
      await executorLoop(values, targets, log);
      return 0;
    case "board-driver":
      await boardLoop(values, targets, log);
      return 0;
    case "play":
      await Promise.all([executorLoop(values, targets, log), boardLoop(values, targets, log)]);
      return 0;
    default:
      process.stderr.write(`harness: unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`harness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
