import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { resolveDataDirectory, UnsupportedPlatformError } from "./data-directory.ts";
import { holderIsRunning, readLock, type LockHolder } from "./lock.ts";

/**
 * The per-user service that keeps `entail run` going without a terminal: a
 * systemd user unit on Linux (WSL included), a launchd agent on macOS and a
 * Task Scheduler task on Windows. It starts at login and, except on Windows,
 * again after a crash, and runs the same `entail run` the owner would run by
 * hand, with the same data directory and port, so the single-copy lock keeps
 * the service and a run by hand from running together.
 *
 * Stopping it is safe at any moment: every call and every owner's action is
 * in the log before entail acts on it, each comment carries the marker of the
 * entry it speaks for, and a restart finds what was already posted, completes
 * an owner's action whose undo window closed, and posts nothing twice.
 */
export type ServiceManager = "systemd" | "launchd" | "task-scheduler";

/** The systemd unit's name, the launchd agent's label and the scheduled task's name. */
export const SERVICE_NAME = "entail";
export const SYSTEMD_UNIT = `${SERVICE_NAME}.service`;
export const LAUNCHD_LABEL = SERVICE_NAME;
export const SCHEDULED_TASK = SERVICE_NAME;

/** On Windows, the script the task runs, in the data directory; its task's definition is written beside it only while the task is created. */
export const WINDOWS_SERVICE_FILE = "entail-service.vbs";
export const WINDOWS_TASK_FILE = "entail-service.xml";

/** How long a crashed service waits before it is started again, in seconds. */
export const RESTART_DELAY_SECONDS = 10;

/** How long the service manager lets a stop take before killing entail, in seconds. */
export const STOP_TIMEOUT_SECONDS = 30;

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
  /** On Windows, the task registered with Task Scheduler, which runs the script at `path`. */
  task?: string;
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
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(node) || !path.isAbsolute(cli)) throw new ServiceError("the service runs entail by absolute paths");
  const environment = serviceEnvironment(platform, env);
  if (platform === "darwin") {
    return { manager: "launchd", path: posix.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), content: launchdPlist({ node, cli, environment }) };
  }
  if (platform === "linux") {
    const xdg = env.XDG_CONFIG_HOME;
    const config = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".config");
    return { manager: "systemd", path: posix.join(config, "systemd", "user", SYSTEMD_UNIT), content: systemdUnit({ node, cli, environment }) };
  }
  if (platform === "win32") {
    const script = win32.join(resolveDataDirectory({ platform, env, home }), WINDOWS_SERVICE_FILE);
    return { manager: "task-scheduler", path: script, content: windowsServiceScript({ node, cli, environment }), task: scheduledTaskXml({ script, user: windowsUser(env) }) };
  }
  throw new UnsupportedPlatformError(platform);
}

/**
 * The environment the service runs with, taken from the shell that installs
 * it, since a service manager starts processes with a bare one: `PATH`, so the
 * service finds the same `git`, `gh` and `claude`; and on Linux an absolute
 * `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, so it uses the same data directory
 * (and lock) as `entail run` by hand, and `gh` the same login; on Windows an
 * absolute `LOCALAPPDATA`, for the same reason. On macOS the data directory
 * depends only on the home directory.
 */
export function serviceEnvironment(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  if (env.PATH) environment.PATH = env.PATH;
  const named = platform === "linux" ? (["XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const) : platform === "win32" ? (["LOCALAPPDATA"] as const) : [];
  const path = platform === "win32" ? win32 : posix;
  for (const name of named) {
    const value = env[name];
    if (value && path.isAbsolute(value)) environment[name] = value;
  }
  return environment;
}

interface DefinitionInputs {
  node: string;
  cli: string;
  environment: Record<string, string>;
}

/**
 * A systemd user unit running `entail run`: `Restart=on-failure` restarts it
 * after a crash but not after a clean stop, and `WantedBy=default.target`
 * starts it with the user's session.
 */
export function systemdUnit({ node, cli, environment }: DefinitionInputs): string {
  return [
    "# Written by `entail service install`; removed by `entail service uninstall`.",
    "[Unit]",
    "Description=entail: the owner's calls on issues and PRs, and the board",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdWord(node, true)} ${systemdWord(cli, true)} run`,
    ...Object.entries(environment).map(([name, value]) => `Environment=${systemdWord(`${name}=${value}`, false)}`),
    "Restart=on-failure",
    `RestartSec=${RESTART_DELAY_SECONDS}`,
    `TimeoutStopSec=${STOP_TIMEOUT_SECONDS}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** One double-quoted word in a unit file: specifiers (`%`) escaped everywhere, and variable expansion (`$`) in `ExecStart=`. */
function systemdWord(value: string, command: boolean): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ServiceError(`cannot write a control character into the service definition: ${JSON.stringify(value)}`);
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (command) escaped = escaped.replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

/**
 * A launchd agent running `entail run`: `RunAtLoad` starts it at login, and
 * `KeepAlive` with `SuccessfulExit` false restarts it after a crash but not
 * after a clean stop.
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

/**
 * The script the Windows task runs with Windows Script Host: it sets the
 * environment, then runs `entail run` with no window, so nothing appears at
 * logon and no window can be closed on it, and waits for it, so the task
 * runs exactly as long as entail does.
 */
export function windowsServiceScript({ node, cli, environment }: DefinitionInputs): string {
  return [
    "' Written by `entail service install`; removed by `entail service uninstall`.",
    'Set shell = CreateObject("WScript.Shell")',
    ...Object.entries(environment).map(([name, value]) => `shell.Environment("Process")(${vbsString(name)}) = ${vbsString(value)}`),
    `WScript.Quit shell.Run(${vbsString(`"${node}" "${cli}" run`)}, 0, True)`,
    "",
  ].join("\r\n");
}

/** A VBScript string literal: in double quotes, each one doubled. */
function vbsString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ServiceError(`cannot write a control character into the service definition: ${JSON.stringify(value)}`);
  return `"${value.replaceAll('"', '""')}"`;
}

/** The Windows account the task runs as and logs in with: `DOMAIN\user`. */
function windowsUser(env: NodeJS.ProcessEnv): string {
  const user = env.USERNAME;
  if (!user) throw new ServiceError("USERNAME is not set, so the task cannot name the user it runs as");
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/**
 * The Task Scheduler task, registered from XML: it runs the script when
 * the user logs in, as that user and without elevation, so a user who is not
 * an administrator can install it. Unlike a task made with `schtasks /SC
 * ONLOGON`, it runs on battery and is never stopped for running too long.
 * Task Scheduler does not start it again after a crash.
 */
export function scheduledTaskXml({ script, user }: { script: string; user: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    "<!-- Written by `entail service install`; removed by `entail service uninstall`. -->",
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>entail: the owner's calls on issues and PRs, and the board</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    `      <UserId>${xml(user)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${xml(user)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>%SystemRoot%\\System32\\wscript.exe</Command>",
    `      <Arguments>//B //NoLogo "${xml(script)}"</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new ServiceError(`cannot write a control character into the service definition: ${JSON.stringify(value)}`);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** What a service-manager command printed and how it exited. */
export interface CommandResult {
  status: number;
  output: string;
}

/** What install, uninstall and status reach the machine through. Replaced by a fake in tests. */
export interface ServiceSystem {
  /** Runs `systemctl`, `launchctl`, or `schtasks` and `powershell.exe`. */
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

/** Whether the kernel is WSL's. */
export function isWsl(kernelRelease: string): boolean {
  return /microsoft|wsl/iu.test(kernelRelease);
}

/**
 * Writes the service definition, enables it to start at login and starts it.
 * An installed service is stopped first and replaced, so installing again
 * picks up a moved Node or entail. Installing refuses while `entail run`
 * by hand holds the lock, since the service would only refuse to start.
 */
export async function installService(inputs: ServiceInputs, system: ServiceSystem): Promise<{ definition: ServiceDefinition; replaced: boolean }> {
  const definition = serviceDefinition(inputs);
  const replaced = existsSync(definition.path);
  if (stopService(definition, inputs, system)) {
    for (let waited = 0; waited < LOCK_RELEASE_WAIT_MS && system.runningCopy(); waited += 250) await system.sleep(250);
  }
  const holder = system.runningCopy();
  if (holder) throw new ServiceError(`entail is already running (pid ${holder.pid}, started ${holder.startedAt}); stop it, then run entail service install again`);

  mkdirSync(dirname(definition.path), { recursive: true });
  // Windows Script Host reads a script with a byte order mark as UTF-16, so any path can be in it.
  writeFileSync(definition.path, definition.manager === "task-scheduler" ? utf16(definition.content) : definition.content, { mode: 0o644 });
  try {
    if (definition.manager === "task-scheduler") {
      // schtasks reads a task's XML as UTF-16, the encoding the XML declares.
      const task = join(dirname(definition.path), WINDOWS_TASK_FILE);
      writeFileSync(task, utf16(definition.task ?? ""));
      try {
        must(system, "schtasks", ["/Create", "/TN", SCHEDULED_TASK, "/XML", task, "/F"], inputs);
      } finally {
        rmSync(task, { force: true });
      }
      must(system, "schtasks", ["/Run", "/TN", SCHEDULED_TASK], inputs);
    } else if (definition.manager === "systemd") {
      must(system, "systemctl", ["--user", "daemon-reload"], inputs);
      must(system, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], inputs);
    } else {
      const domain = `gui/${inputs.uid}`;
      // Clears a disabled override left by `launchctl disable`, which would keep the agent from loading.
      must(system, "launchctl", ["enable", `${domain}/${LAUNCHD_LABEL}`], inputs);
      must(system, "launchctl", ["bootstrap", domain, definition.path], inputs);
    }
  } catch (error) {
    rmSync(definition.path, { force: true });
    if (definition.manager === "systemd") system.exec("systemctl", ["--user", "daemon-reload"]);
    if (definition.manager === "task-scheduler") system.exec("schtasks", ["/Delete", "/TN", SCHEDULED_TASK, "/F"]);
    throw error;
  }
  return { definition, replaced };
}

/** Stops the service, keeps it from starting at login and removes its definition; `removed` is false when none was installed. */
export function uninstallService(inputs: ServiceInputs, system: ServiceSystem): { definition: ServiceDefinition; removed: boolean } {
  const definition = serviceDefinition(inputs);
  if (!existsSync(definition.path)) {
    // A launchd agent can stay loaded after its plist was deleted by hand; unload it so nothing keeps running.
    if (definition.manager === "launchd") stopService(definition, inputs, system);
    return { definition, removed: false };
  }
  if (definition.manager === "systemd") {
    must(system, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], inputs);
    rmSync(definition.path, { force: true });
    system.exec("systemctl", ["--user", "daemon-reload"]);
  } else if (definition.manager === "task-scheduler") {
    stopService(definition, inputs, system);
    must(system, "schtasks", ["/Delete", "/TN", SCHEDULED_TASK, "/F"], inputs);
    rmSync(definition.path, { force: true });
  } else {
    stopService(definition, inputs, system);
    rmSync(definition.path, { force: true });
  }
  return { definition, removed: true };
}

/** Where the service stands on this machine. */
export interface ServiceStatus {
  definition: ServiceDefinition;
  installed: boolean;
  /** Whether the service manager says the service is running now. */
  active: boolean;
  /** Whether it starts at login. */
  enabled: boolean;
  /** The copy of entail holding the lock: the service's, or one run by hand. */
  running: LockHolder | null;
}

/** Reads where the service stands, from its definition, the service manager and the lock. */
export function serviceStatus(inputs: ServiceInputs, system: ServiceSystem): ServiceStatus {
  const definition = serviceDefinition(inputs);
  const installed = existsSync(definition.path);
  let active = false;
  let enabled = false;
  if (installed) {
    if (definition.manager === "systemd") {
      active = system.exec("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]).status === 0;
      enabled = system.exec("systemctl", ["--user", "is-enabled", "--quiet", SYSTEMD_UNIT]).status === 0;
    } else if (definition.manager === "task-scheduler") {
      // The task's state by name (Ready, Running, Disabled, Queued), which unlike schtasks' text is the same in every language.
      const queried = system.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", TASK_STATE_QUERY]);
      const state = queried.status === 0 ? queried.output.trim() : "";
      enabled = state !== "" && state !== "Disabled";
      active = state === "Running";
    } else {
      const printed = system.exec("launchctl", ["print", `gui/${inputs.uid}/${LAUNCHD_LABEL}`]);
      enabled = printed.status === 0;
      active = enabled && /^\s*state = running\s*$/mu.test(printed.output);
    }
  }
  return { definition, installed, active, enabled, running: system.runningCopy() };
}

/** Stops an installed service, if any, and says whether one was stopped; a service never loaded has nothing to stop. */
function stopService(definition: ServiceDefinition, inputs: ServiceInputs, system: ServiceSystem): boolean {
  if (definition.manager === "task-scheduler") return existsSync(definition.path) && system.exec("schtasks", ["/End", "/TN", SCHEDULED_TASK]).status === 0;
  if (definition.manager === "systemd") return existsSync(definition.path) && system.exec("systemctl", ["--user", "stop", SYSTEMD_UNIT]).status === 0;
  return system.exec("launchctl", ["bootout", `gui/${inputs.uid}/${LAUNCHD_LABEL}`]).status === 0;
}

/** What prints the Windows task's state. */
export const TASK_STATE_QUERY = `(Get-ScheduledTask -TaskName ${SCHEDULED_TASK} -ErrorAction Stop).State`;

/** Text as UTF-16 with a byte order mark. */
function utf16(text: string): Buffer {
  return Buffer.from(`\ufeff${text}`, "utf16le");
}

function must(system: ServiceSystem, file: string, args: string[], inputs: ServiceInputs): void {
  const result = system.exec(file, args);
  if (result.status === 0) return;
  let message = `${file} ${args.join(" ")} failed: ${result.output === "" ? `exit ${result.status}` : result.output}`;
  if (file === "systemctl" && inputs.platform === "linux" && isWsl(system.kernelRelease())) {
    message += "\nOn WSL, systemd must be enabled: set systemd=true under [boot] in /etc/wsl.conf, then restart WSL.";
  }
  throw new ServiceError(message);
}
