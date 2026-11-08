#!/usr/bin/env node
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureDataDirectory, UnsupportedPlatformError } from "./data-directory.ts";
import { LockHeldError } from "./lock.ts";
import { startRun, type RunningEntail } from "./run.ts";
import { BoardPortTakenError } from "./server.ts";
import { installService, machineServiceSystem, ServiceError, uninstallService, type ServiceInputs } from "./service.ts";
import { StoreOpenError } from "./store.ts";

const USAGE = `Usage: entail <command>

Commands:
  run                Run entail in the foreground until SIGINT or SIGTERM
  service install    Run entail as a per-user service that starts at login
                     and restarts after a crash
  service uninstall  Stop the service and remove it
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
  if (command === "service" && rest.length === 1 && (rest[0] === "install" || rest[0] === "uninstall")) {
    return serviceCommand(rest[0]);
  }
  process.stderr.write(`entail: unknown command: ${argv.join(" ")}\n\n${USAGE}`);
  return 2;
}

async function runCommand(): Promise<number> {
  // Handle the signals before starting, so a stop requested while entail is
  // still starting is kept and acted on once it has started, and still
  // releases the lock.
  let running: RunningEntail | undefined;
  let requested: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (running) running.stop(signal);
    else requested = signal;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    running = await startRun({ dataDirectory: ensureDataDirectory() });
  } catch (error) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (
      error instanceof LockHeldError ||
      error instanceof UnsupportedPlatformError ||
      error instanceof StoreOpenError ||
      error instanceof BoardPortTakenError
    ) {
      process.stderr.write(`entail: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (requested) running.stop(requested);
  await running.stopped;
  return 0;
}

async function serviceCommand(action: "install" | "uninstall"): Promise<number> {
  const inputs: ServiceInputs = {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
  };
  const system = machineServiceSystem(inputs);
  try {
    if (action === "install") {
      const { definition, replaced } = await installService(inputs, system);
      const kind = definition.manager === "systemd" ? "systemd user unit" : "launchd agent";
      process.stdout.write(
        `${replaced ? "Replaced" : "Installed"} the entail service, a ${kind} at ${definition.path}. ` +
          "It is running now, starts at login and restarts after a crash.\n",
      );
    } else {
      const { definition, removed } = uninstallService(inputs, system);
      process.stdout.write(
        removed ? `Stopped and removed the entail service at ${definition.path}.\n` : "The entail service is not installed.\n",
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof ServiceError || error instanceof UnsupportedPlatformError) {
      process.stderr.write(`entail: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
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
