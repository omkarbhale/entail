import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveDataDirectory, UnsupportedPlatformError } from "./data-directory.ts";
import { holderIsRunning, readLock, type LockHolder } from "./lock.ts";
import { isWsl } from "./notice.ts";

/**
 * The per-user service that keeps `entail run` running without a terminal
 * (spec §1, ADR-0017): a systemd user unit on Linux and WSL, a launchd agent
 * on macOS. It starts at login and restarts after a crash, and it runs the
 * same command as the foreground `entail run`, so the single-copy lock keeps
 * the service and a foreground run from ever running together.
 */
export type ServiceManager = "systemd" | "launchd";

/** The systemd unit's name, and the launchd agent's label. */
export const SERVICE_NAME = "entail";
export const SYSTEMD_UNIT = `${SERVICE_NAME}.service`;
export const LAUNCHD_LABEL = SERVICE_NAME;

/** How long a crashed service waits before it is started again, in seconds. */
export const RESTART_DELAY_SECONDS = 10;

/**
 * How long the service manager lets a stop take before killing entail, in
 * seconds. Stopping waits up to 10 seconds for forge writes, then commits and
 * pushes the records repo (ADR-0017).
 */
export const STOP_TIMEOUT_SECONDS = 60;

/** How long install waits for a stopped service to release the lock. */
export const LOCK_RELEASE_WAIT_MS = STOP_TIMEOUT_SECONDS * 1000;

/** The machine the service is installed on. */
export interface ServiceInputs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The user's id, which names the launchd domain (`gui/<uid>`). */
  uid: number;
  /** The absolute path of the Node binary that runs entail. */
  node: string;
  /** The absolute path of the entail CLI script. */
  cli: string;
}

/** A service definition: the file to write and what it says. */
export interface ServiceDefinition {
  manager: ServiceManager;
  path: string;
  content: string;
}

/** A service install or uninstall that could not be completed. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

/** The service definition for this machine. */
export function serviceDefinition(inputs: ServiceInputs): ServiceDefinition {
  const { platform, env, home, node, cli } = inputs;
  if (!isAbsolute(node) || !isAbsolute(cli)) {
    throw new ServiceError("the service runs entail by absolute paths");
  }
  const environment = serviceEnvironment(platform, env);
  if (platform === "darwin") {
    return {
      manager: "launchd",
      path: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      content: launchdPlist({ node, cli, environment }),
    };
  }
  if (platform === "linux") {
    const xdg = env.XDG_CONFIG_HOME;
    const config = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
    return {
      manager: "systemd",
      path: join(config, "systemd", "user", SYSTEMD_UNIT),
      content: systemdUnit({ node, cli, environment }),
    };
  }
  throw new UnsupportedPlatformError(platform);
}

/**
 * The environment the service runs with, taken from the shell that installs
 * it. A service manager starts processes with a bare environment, so:
 *
 * - `PATH` is kept, so the service finds the same `git`, `claude`, `gh` and
 *   `glab` the owner's shell does.
 * - `XDG_DATA_HOME` is kept on Linux, so the service uses the same data
 *   directory, and therefore the same lock, as a foreground `entail run`.
 *   On macOS the data directory depends only on the home directory.
 */
export function serviceEnvironment(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  if (env.PATH) environment.PATH = env.PATH;
  if (platform === "linux" && env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)) {
    environment.XDG_DATA_HOME = env.XDG_DATA_HOME;
  }
  return environment;
}

interface DefinitionInputs {
  node: string;
  cli: string;
  environment: Record<string, string>;
}

/**
 * A systemd user unit running `entail run`.
 *
 * - `Restart=on-failure` restarts it after a crash (a non-zero exit or a
 *   signal), but not after a clean stop.
 * - `WantedBy=default.target` starts it when the user's session starts.
 * - `KillMode=mixed` sends SIGTERM to entail alone, so entail stops its own
 *   model runs as ADR-0017 orders, and kills whatever is left at the timeout.
 */
export function systemdUnit({ node, cli, environment }: DefinitionInputs): string {
  const lines = [
    "# Written by `entail service install`; removed by `entail service uninstall`.",
    "[Unit]",
    "Description=entail",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdWord(node, true)} ${systemdWord(cli, true)} run`,
    ...Object.entries(environment).map(([name, value]) => `Environment=${systemdWord(`${name}=${value}`, false)}`),
    "Restart=on-failure",
    `RestartSec=${RESTART_DELAY_SECONDS}`,
    "KillMode=mixed",
    `TimeoutStopSec=${STOP_TIMEOUT_SECONDS}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

/**
 * One double-quoted word in a unit file. Specifiers (`%`) are escaped
 * everywhere, and variable expansion (`$`) in `ExecStart=`.
 */
function systemdWord(value: string, command: boolean): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceError(`cannot write a control character into the service definition: ${JSON.stringify(value)}`);
  }
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (command) escaped = escaped.replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

/**
 * A launchd agent running `entail run`.
 *
 * - `RunAtLoad` starts it when it is loaded, which happens at login for an
 *   agent in `~/Library/LaunchAgents`.
 * - `KeepAlive` with `SuccessfulExit` false restarts it after a crash, but not
 *   after a clean stop.
 */
export function launchdPlist({ node, cli, environment }: DefinitionInputs): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Written by `entail service install`; removed by `entail service uninstall`. -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(LAUNCHD_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[node, cli, "run"].map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
  ];
  const variables = Object.entries(environment);
  if (variables.length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [name, value] of variables) lines.push(`    <key>${xml(name)}</key>`, `    <string>${xml(value)}</string>`);
    lines.push("  </dict>");
  }
  lines.push(
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${RESTART_DELAY_SECONDS}</integer>`,
    "  <key>ExitTimeOut</key>",
    `  <integer>${STOP_TIMEOUT_SECONDS}</integer>`,
    "</dict>",
    "</plist>",
    "",
  );
  return lines.join("\n");
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new ServiceError(`cannot write a control character into the service definition: ${JSON.stringify(value)}`);
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** What a service-manager command printed and how it exited. */
export interface CommandResult {
  status: number;
  output: string;
}

/** What install and uninstall reach the machine through. Replaceable in tests. */
export interface ServiceSystem {
  /** Runs `systemctl` or `launchctl`. */
  exec(file: string, args: string[]): CommandResult;
  /** The copy of entail holding the lock, when one is running. */
  runningCopy(): LockHolder | null;
  /** Waits this long; used while a stopped service releases the lock. */
  sleep(ms: number): Promise<void>;
  /** The kernel release, which tells WSL apart from Linux. */
  kernelRelease(): string;
}

/** The real machine: its service manager, and the lock in its data directory. */
export function machineServiceSystem(inputs: Pick<ServiceInputs, "platform" | "env" | "home">): ServiceSystem {
  return {
    exec(file, args) {
      const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (result.error) return { status: -1, output: result.error.message };
      return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}`.trim() };
    },
    runningCopy() {
      const holder = readLock(resolveDataDirectory(inputs));
      return holder && holderIsRunning(holder) ? holder : null;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    kernelRelease: release,
  };
}

export interface InstallResult {
  definition: ServiceDefinition;
  /** Whether a service was already installed and has been replaced. */
  replaced: boolean;
}

/**
 * Writes the service definition, enables it to start at login and starts it.
 *
 * An installed service is stopped first and replaced, so installing again
 * picks up a moved Node or entail. Installing refuses while a foreground
 * `entail run` holds the lock, because the service would only refuse to start.
 */
export async function installService(inputs: ServiceInputs, system: ServiceSystem): Promise<InstallResult> {
  const definition = serviceDefinition(inputs);
  const replaced = existsSync(definition.path);
  if (stopService(definition, inputs, system)) await waitForLockRelease(system);
  const holder = system.runningCopy();
  if (holder) {
    throw new ServiceError(
      `entail is already running (pid ${holder.pid}, started ${holder.startedAt}); stop it, then run entail service install again`,
    );
  }

  mkdirSync(dirname(definition.path), { recursive: true });
  writeFileSync(definition.path, definition.content, { mode: 0o644 });
  try {
    if (definition.manager === "systemd") {
      must(system, "systemctl", ["--user", "daemon-reload"], inputs);
      must(system, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], inputs);
    } else {
      const domain = `gui/${inputs.uid}`;
      // Clears a disabled override left by `launchctl disable`, which would
      // otherwise keep the agent from loading.
      must(system, "launchctl", ["enable", `${domain}/${LAUNCHD_LABEL}`], inputs);
      must(system, "launchctl", ["bootstrap", domain, definition.path], inputs);
    }
  } catch (error) {
    rmSync(definition.path, { force: true });
    if (definition.manager === "systemd") system.exec("systemctl", ["--user", "daemon-reload"]);
    throw error;
  }
  return { definition, replaced };
}

export interface UninstallResult {
  definition: ServiceDefinition;
  /** False when no service was installed. */
  removed: boolean;
}

/** Stops the service, keeps it from starting at login and removes its definition. */
export function uninstallService(inputs: ServiceInputs, system: ServiceSystem): UninstallResult {
  const definition = serviceDefinition(inputs);
  if (!existsSync(definition.path)) {
    // Nothing to remove, but a launchd agent can stay loaded after its plist
    // was deleted by hand; unload it so nothing keeps running.
    if (definition.manager === "launchd") stopService(definition, inputs, system);
    return { definition, removed: false };
  }
  if (definition.manager === "systemd") {
    must(system, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], inputs);
    rmSync(definition.path, { force: true });
    system.exec("systemctl", ["--user", "daemon-reload"]);
  } else {
    stopService(definition, inputs, system);
    rmSync(definition.path, { force: true });
  }
  return { definition, removed: true };
}

/**
 * Stops an installed service, if any, and says whether one was stopped.
 * Failures are ignored: a service that was never loaded has nothing to stop.
 */
function stopService(definition: ServiceDefinition, inputs: ServiceInputs, system: ServiceSystem): boolean {
  if (definition.manager === "systemd") {
    return existsSync(definition.path) && system.exec("systemctl", ["--user", "stop", SYSTEMD_UNIT]).status === 0;
  }
  return system.exec("launchctl", ["bootout", `gui/${inputs.uid}/${LAUNCHD_LABEL}`]).status === 0;
}

/** Waits for a copy that is stopping to release the lock, up to {@link LOCK_RELEASE_WAIT_MS}. */
async function waitForLockRelease(system: ServiceSystem): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < LOCK_RELEASE_WAIT_MS && system.runningCopy(); waited += step) {
    await system.sleep(step);
  }
}

function must(system: ServiceSystem, file: string, args: string[], inputs: ServiceInputs): void {
  const result = system.exec(file, args);
  if (result.status === 0) return;
  const detail = result.output === "" ? `exit ${result.status}` : result.output;
  let message = `${file} ${args.join(" ")} failed: ${detail}`;
  if (file === "systemctl" && inputs.platform === "linux" && isWsl(system.kernelRelease())) {
    message += "\nOn WSL, systemd must be enabled: set systemd=true under [boot] in /etc/wsl.conf, then restart WSL.";
  }
  throw new ServiceError(message);
}
