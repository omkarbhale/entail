#!/usr/bin/env node
import { ensureDataDirectory, UnsupportedPlatformError } from "./data-directory.ts";
import { LockHeldError } from "./lock.ts";
import { startRun, type RunningEntail } from "./run.ts";
import { StoreOpenError } from "./store.ts";

const USAGE = `Usage: entail <command>

Commands:
  run    Run entail in the foreground until SIGINT or SIGTERM
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "run" && rest.length === 0) {
    return runCommand();
  }
  process.stderr.write(`entail: unknown command: ${argv.join(" ")}\n\n${USAGE}`);
  return 2;
}

async function runCommand(): Promise<number> {
  // Handle the signals before announcing the start, so a stop requested as
  // soon as entail says it started still releases the lock.
  let running: RunningEntail | undefined;
  const onSignal = (signal: NodeJS.Signals) => running?.stop(signal);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    running = startRun({ dataDirectory: ensureDataDirectory() });
  } catch (error) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (error instanceof LockHeldError || error instanceof UnsupportedPlatformError || error instanceof StoreOpenError) {
      process.stderr.write(`entail: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  await running.stopped;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`entail: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
