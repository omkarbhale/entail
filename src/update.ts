import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { StatusView } from "./api-types.ts";
import { RUN_TIMEOUT_MS } from "./claude-runner.ts";
import { restartService, serviceStatus, type CommandResult, type ServiceInputs, type ServiceSystem, type ServiceStatus } from "./service.ts";
import { windowsCommand } from "./windows.ts";

/**
 * `entail update`: brings the entail running on this machine to the code in
 * the entail checkout it is run from, without cutting off work in flight.
 *
 * 1. It refuses unless the current directory is a git checkout of entail
 *    with no uncommitted change to a tracked file, and, when entail is
 *    running, unless that copy runs from this checkout: updating an install
 *    elsewhere is not what it does.
 * 2. It fast-forwards the current branch (`git pull --ff-only`), then runs
 *    `npm ci` and `npm run build`. Any failure stops it there and leaves the
 *    running entail alone. The running copy keeps going meanwhile: it loaded
 *    its code when it started, and needs nothing from `node_modules`.
 * 3. When nothing is running, that is the whole update.
 * 4. Otherwise it drains the running copy before stopping it: a request to
 *    `POST /api/drain` on the loopback API makes the loop start no new pass,
 *    not the interval's, a check asked on the board or an act-only pass when
 *    an undo window closes, and lets the pass in flight finish, with its
 *    model runs (each up to {@link RUN_TIMEOUT_MS}) and the start commands
 *    a go runs. It polls `GET /api/status` until the copy is drained and no
 *    pass runs. Stopping entail outright would not do: on SIGTERM it aborts
 *    the pass and the model runs in it, and the service manager kills it
 *    after STOP_TIMEOUT_SECONDS (30 s), far less than one model run. A copy
 *    from before this command has no drain; it is restarted the moment no
 *    pass runs instead. Interrupted, or past {@link DRAIN_TIMEOUT_MS}, the
 *    update resumes the copy, which takes work again, and stops.
 * 5. Drained, the copy is restarted. A service (systemd, launchd or Task
 *    Scheduler) is restarted through its service manager, so the new code
 *    runs exactly as the old did; the board is served by the same process
 *    and comes back with it. A copy run by hand (`entail run` in a terminal)
 *    is stopped, not restarted, since the update cannot own its terminal: the
 *    owner starts it again. If the restart fails, the copy is resumed when it
 *    is still running. What came due while it was drained is in the log and
 *    is acted on after the restart, as after any restart.
 */

/** How long the update waits for the pass in flight to finish before it gives up and lets entail take work again. */
export const DRAIN_TIMEOUT_MS = 60 * 60_000;
/** How often the update reads the running copy's status while it drains. */
export const DRAIN_POLL_MS = 2_000;
/** How long the update waits for the restarted service to hold the lock and answer. */
export const START_WAIT_MS = 30_000;

/** What `entail update` reads of the running copy's status; a copy from before the drain has no `draining`, `pid` or `cli`. */
export type RunningStatus = Pick<StatusView, "checking"> & Partial<Pick<StatusView, "draining" | "pid" | "cli">>;

/** The running copy's loopback API, as the update reaches it. Replaced by a fake in tests. */
export interface RunningApi {
  /** Its status, or null when nothing answers. */
  status(): Promise<RunningStatus | null>;
  /** Drains it; "unsupported" when the copy predates the drain. */
  drain(): Promise<RunningStatus | "unsupported">;
  /** Lets it take work again. */
  resume(): Promise<void>;
}

/** What the update reaches the machine through, beside the service manager. Replaced by a fake in tests. */
export interface UpdateMachine {
  /** Runs `git` or `npm` in the checkout. */
  run(file: "git" | "npm", args: string[], cwd: string): CommandResult;
  api: RunningApi;
  /** A process's command line, or "" when it cannot be read. */
  commandLine(pid: number): string;
  /** Stops a copy run by hand, which is idle once drained. */
  stop(pid: number): void;
}

export interface UpdateOptions {
  /** The directory `entail update` is run from. */
  checkout: string;
  /** Where the running copy's board is served. */
  url: string;
  inputs: ServiceInputs;
  system: ServiceSystem;
  machine: UpdateMachine;
  print: (line: string) => void;
  /** Aborted when the owner interrupts the update. */
  signal?: AbortSignal;
  pollMs?: number;
  drainTimeoutMs?: number;
  startWaitMs?: number;
}

/** An update that was refused or could not be completed; its message says what to do. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateResult {
  before: string;
  after: string;
  /** How the running copy was brought to the new code: restarted as the service, stopped for the owner to start again, or nothing was running. */
  restarted: "service" | "by-hand" | "not-running";
}

/** Updates the checkout and the copy running from it; see the module header for each step. */
export async function update(options: UpdateOptions): Promise<UpdateResult> {
  const { checkout, machine, system, print, url } = options;
  checkCheckout(checkout, machine);

  const running = system.runningCopy();
  let how: "service" | "by-hand" = "by-hand";
  if (running !== null) {
    const status = await machine.api.status();
    if (status === null) throw new UpdateError(`entail is running (pid ${running.pid}), but its board does not answer at ${url}: if it serves another port, pass it with --port`);
    if (status.pid !== undefined && status.pid !== running.pid) throw new UpdateError(`the board at ${url} is served by pid ${status.pid}, not by the entail holding the lock (pid ${running.pid}): pass --port with the port that entail serves on`);
    const service = installedService(options);
    how = service?.installed && service.active ? "service" : "by-hand";
    checkRunsFrom(checkout, runningFrom(status, how === "service" ? service : null, machine, running.pid), running.pid);
  }

  const before = git(machine, checkout, ["rev-parse", "--short", "HEAD"]);
  const pulled = machine.run("git", ["pull", "--ff-only"], checkout);
  if (pulled.status !== 0) throw new UpdateError(`git pull --ff-only failed, so nothing was updated${running === null ? "" : " and the running entail was left alone"}: ${output(pulled)}\nIf the branch has diverged from its upstream, bring it in line first.`);
  const after = git(machine, checkout, ["rev-parse", "--short", "HEAD"]);
  for (const args of [["ci"], ["run", "build"]]) {
    const result = machine.run("npm", args, checkout);
    if (result.status !== 0) {
      throw new UpdateError(`npm ${args.join(" ")} failed at ${after}${running === null ? "" : `; the running entail (pid ${running.pid}) was left alone on the code it started with`}: ${output(result)}`);
    }
  }
  print(before === after ? `The checkout is already at ${after}; built it again.` : `Updated the checkout ${before} → ${after} and built it.`);

  if (running === null) {
    print("entail is not running, so there is nothing to restart. Start it with: node dist/cli.js service install (or node dist/cli.js run)");
    return { before, after, restarted: "not-running" };
  }

  await drain(options, running.pid);

  if (how === "by-hand") {
    machine.stop(running.pid);
    const stopped = await waitFor(system, () => system.runningCopy()?.pid !== running.pid, options.startWaitMs ?? START_WAIT_MS);
    if (!stopped) throw new UpdateError(`entail (pid ${running.pid}) was asked to stop but is still running the code it started with: stop it yourself, then start it on ${after}: node dist/cli.js run`);
    print(`entail was running by hand (pid ${running.pid}): it finished the work in flight and was stopped, since the update cannot restart it in its terminal. Start it again on ${after}: node dist/cli.js run`);
    return { before, after, restarted: "by-hand" };
  }

  try {
    await restartService(options.inputs, system);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (system.runningCopy()?.pid === running.pid) {
      await resumeIfRunning(options, running.pid);
      throw new UpdateError(`the service could not be restarted, so entail still runs the code it started with and takes work again: ${reason}`);
    }
    throw new UpdateError(`the service was stopped but could not be started again on ${after}, so entail is not running: ${reason}\nStart it with: node dist/cli.js service install`);
  }
  const back = await waitFor(
    system,
    async () => {
      const holder = system.runningCopy();
      return holder !== null && holder.pid !== running.pid && (await machine.api.status()) !== null;
    },
    options.startWaitMs ?? START_WAIT_MS,
  );
  if (!back) throw new UpdateError(`the service was restarted on ${after}, but entail has not come back yet: see entail service status`);
  print(`The entail service runs ${after} now (was ${before}); the board: ${url}`);
  return { before, after, restarted: "service" };
}

/** Refuses anything but a git checkout of entail with no uncommitted change to a tracked file. */
function checkCheckout(checkout: string, machine: UpdateMachine): void {
  let name: unknown = null;
  try {
    name = (JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    // No package.json, or not JSON: not entail's.
  }
  if (!existsSync(join(checkout, ".git")) || name !== "entail") {
    throw new UpdateError(`entail update updates the git checkout of entail it is run from, and ${checkout} is not one (expected a .git and a package.json named entail): run it from the root of entail's checkout`);
  }
  const changed = machine.run("git", ["status", "--porcelain", "--untracked-files=no"], checkout);
  if (changed.status !== 0) throw new UpdateError(`git status failed in ${checkout}: ${output(changed)}`);
  if (changed.output.trim() !== "") {
    throw new UpdateError(`the checkout at ${checkout} has uncommitted changes, so nothing was updated: commit or discard them first.\n${changed.output.trimEnd()}`);
  }
}

/** The service, when one is installed on this machine; null where there is no service manager. */
function installedService(options: UpdateOptions): ServiceStatus | null {
  try {
    return serviceStatus(options.inputs, options.system);
  } catch {
    return null;
  }
}

/** Where the running copy runs from: the script it reports, else the service's definition, else its command line. */
function runningFrom(status: RunningStatus, service: ServiceStatus | null, machine: UpdateMachine, pid: number): { cli: string } | { text: string } {
  if (typeof status.cli === "string" && status.cli !== "") return { cli: status.cli };
  if (service !== null) {
    const bytes = readFileSync(service.definition.path);
    return { text: service.definition.manager === "task-scheduler" ? bytes.toString("utf16le") : bytes.toString("utf8") };
  }
  return { text: machine.commandLine(pid) };
}

/** Refuses when the running copy runs from somewhere other than this checkout. */
function checkRunsFrom(checkout: string, from: { cli: string } | { text: string }, pid: number): void {
  const here = join(checkout, "dist", "cli.js");
  if ("cli" in from) {
    // Compared as given and with links resolved, since either side may be reached through a symlink (macOS's /var is /private/var).
    if (inside(from.cli, checkout) || inside(real(from.cli), real(checkout))) return;
    throw new UpdateError(`entail runs from ${from.cli} (pid ${pid}), not from this checkout (${here}): entail update updates only the copy running from the checkout it is run from`);
  }
  if (from.text === "") throw new UpdateError(`cannot tell where the running entail (pid ${pid}) runs from, so it was not updated; it should run ${here}`);
  for (const root of new Set([checkout, real(checkout)])) {
    if (from.text.includes(join(root, "dist", "cli.js")) || from.text.includes(join(root, "src", "cli.ts"))) return;
  }
  throw new UpdateError(`entail runs from somewhere other than this checkout (pid ${pid}: ${from.text.split(/\r?\n/u).find((line) => /cli\.(js|ts)/u.test(line))?.trim() ?? from.text.trim()}), not ${here}: entail update updates only the copy running from the checkout it is run from`);
}

/** Drains the running copy and waits until no pass runs in it, or until it is gone. */
async function drain(options: UpdateOptions, pid: number): Promise<void> {
  const { machine, system, print } = options;
  const drained = await machine.api.drain();
  const legacy = drained === "unsupported";
  if (legacy) print("The running entail predates entail update and cannot be told to take no new work: it is restarted as soon as no pass runs.");
  const limit = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  const poll = options.pollMs ?? DRAIN_POLL_MS;
  let told = false;
  for (let waited = 0; ; waited += poll) {
    if (options.signal?.aborted) {
      if (!legacy) await resumeIfRunning(options, pid);
      throw new UpdateError(`the update was interrupted${legacy ? "" : "; entail takes work again"} and still runs the code it started with; the checkout is built, so run entail update again to restart it`);
    }
    const status = await machine.api.status();
    if (status === null || system.runningCopy()?.pid !== pid) return; // It stopped meanwhile: nothing is in flight.
    if (!status.checking && (legacy || status.draining === true)) return;
    if (!legacy && status.draining === false) await machine.api.drain(); // Resumed meanwhile, from elsewhere.
    if (waited >= limit) {
      if (!legacy) await resumeIfRunning(options, pid);
      throw new UpdateError(`the pass in flight did not finish within ${Math.round(limit / 60_000)} minutes, so entail was not restarted${legacy ? "" : " and takes work again"}; run entail update again later`);
    }
    if (!told && status.checking) {
      print(`Waiting for the pass in flight to finish before restarting (a model run can take up to ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes)...`);
      told = true;
    }
    await system.sleep(poll);
  }
}

async function resumeIfRunning(options: UpdateOptions, pid: number): Promise<void> {
  if (options.system.runningCopy()?.pid !== pid) return;
  try {
    await options.machine.api.resume();
  } catch {
    // It stopped meanwhile.
  }
}

/** Waits until `ready`, up to `limitMs`; whether it became ready. */
async function waitFor(system: ServiceSystem, ready: () => boolean | Promise<boolean>, limitMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += 250) {
    if (await ready()) return true;
    if (waited >= limitMs) return false;
    await system.sleep(250);
  }
}

function git(machine: UpdateMachine, checkout: string, args: string[]): string {
  const result = machine.run("git", args, checkout);
  if (result.status !== 0) throw new UpdateError(`git ${args.join(" ")} failed: ${output(result)}`);
  return result.output.trim();
}

function output(result: CommandResult): string {
  const text = result.output.trim();
  if (text === "") return `exit ${result.status}`;
  const lines = text.split(/\r?\n/u);
  return lines.length > 20 ? lines.slice(-20).join("\n") : text;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The real machine: `git` and `npm` run in the checkout, the running copy's API on the loopback host. */
export function machineUpdate(url: string, commandLine: (pid: number) => string): UpdateMachine {
  const call = async (method: string, path: string): Promise<Response | null> => {
    try {
      return await fetch(`${url}${path}`, {
        method,
        signal: AbortSignal.timeout(5_000),
        ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: "{}" }),
      });
    } catch {
      return null;
    }
  };
  return {
    run(file, args, cwd) {
      const command = process.platform === "win32" ? windowsCommand(file, args, process.env) : { file, args, verbatim: false };
      const result = spawnSync(command.file, command.args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: command.verbatim, maxBuffer: 64 * 1024 * 1024 });
      if (result.error) return { status: -1, output: result.error.message };
      return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
    },
    api: {
      async status() {
        const response = await call("GET", "api/status");
        return response?.ok ? ((await response.json()) as RunningStatus) : null;
      },
      async drain() {
        const response = await call("POST", "api/drain");
        if (response?.status === 404) return "unsupported";
        if (response === null || !response.ok) {
          const body = response === null ? null : ((await response.json().catch(() => null)) as { error?: string } | null);
          throw new UpdateError(`entail could not be drained for the update: ${body?.error ?? (response === null ? "its board does not answer" : `HTTP ${response.status}`)}; nothing was restarted`);
        }
        return (await response.json()) as RunningStatus;
      },
      async resume() {
        await call("DELETE", "api/drain");
      },
    },
    commandLine,
    stop(pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
}
