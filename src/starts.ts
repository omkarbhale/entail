import { spawn } from "node:child_process";
import { criteriaOf, type Pending } from "./records.ts";
import { cmdArguments, killTree } from "./windows.ts";

/**
 * Starting work on a go: a command the owner sets (`entail settings --start
 * '<command>'`), run when a go call acts — at once when the repo's confirm
 * mode is off, and once the owner confirms the go, answers go or overrides to
 * go (a go made differently included) when it is on. Never for a no or an
 * ask. entail runs it with `/bin/sh -c` (`cmd.exe /d /s /c` on Windows) and
 * the handoff as JSON on standard input, and records in the repo's log that
 * work was started, by which command and with what exit status. A command that fails is recorded and
 * never holds up the call. Work starts once per issue: after a start that
 * exited 0, a later go on the same issue starts nothing.
 *
 * entail depends on no particular executor: `examples/start-to-file.sh`
 * appends the handoff to a file. The PR that later closes the issue is judged
 * at landing like any other.
 */

/** How long a start command may run before entail stops it: it hands the work off and returns. */
export const START_TIMEOUT_MS = 60_000;
/** How long a command gets to stop after SIGTERM before its process group is killed; on Windows its process tree is killed at once. */
export const START_KILL_GRACE_MS = 5_000;

/** What the start command reads on standard input. */
export interface Handoff {
  repo: string;
  issue: { number: number; url: string; title: string };
  /** The log entry of the go that acted: entail's call, or the owner's action on it. */
  call: number;
  /** Whose go it is: entail's alone, or the owner's (a confirmation, an answer or an override). */
  by: "entail" | "owner";
  reason: string;
  /** What the PR must do beyond solving the issue, each with where it comes from. */
  criteria: { criterion: string; source: string; basis: string }[];
  /** VISION.md's commit the go was made against, or null when the repo has none. */
  vision: string | null;
}

/**
 * The handoff for an act, when the act is a go acting: entail's go with
 * confirm mode off, the owner's confirmation of a go, a go run again on the
 * owner's word, or a go made differently. Null for anything else.
 */
export function handoffFor(repo: string, pending: Pending): Handoff | null {
  const of = (call: Extract<Pending, { kind: "call" }>["entry"]) => ({
    repo,
    issue: { number: call.issue.number, url: call.issue.url, title: call.issue.title },
    vision: call.vision?.commit ?? null,
  });
  switch (pending.kind) {
    case "call": {
      const { entry } = pending;
      if (entry.owner !== null) {
        if (entry.owner.call !== "go") return null;
        const reason = entry.owner.kind === "answer" && entry.call.call === "go" ? entry.call.reason : entry.owner.words;
        return { ...of(entry), call: entry.id, by: "owner", reason, criteria: criteriaOf(entry.call) };
      }
      if (entry.call.call !== "go" || entry.confirm) return null;
      return { ...of(entry), call: entry.id, by: "entail", reason: entry.call.reason, criteria: entry.call.criteria };
    }
    case "confirmed": {
      const { call, action } = pending;
      if (call.call.call !== "go") return null;
      return { ...of(call), call: action.id, by: "owner", reason: call.call.reason, criteria: call.call.criteria };
    }
    case "owner-go": {
      const { call, action } = pending;
      return { ...of(call), call: action.id, by: "owner", reason: call.call.reason, criteria: [{ criterion: action.reason, source: "owner", basis: "the owner's go, made differently, word for word" }] };
    }
    default:
      return null;
  }
}

export interface StartResult {
  /** The command's exit status; null when it did not exit on its own. */
  exit: number | null;
  /** What went wrong, when it did not exit 0. */
  error?: string;
}

/**
 * Runs the start command with the handoff as JSON on its standard input. The
 * command is done when its shell exits, so one that hands off to a process
 * left running in the background returns at once. One still running at the
 * timeout is stopped, with everything it started that is still in its process
 * group, or on Windows in its process tree.
 */
export function runStart(command: string, handoff: Handoff, timeoutMs = START_TIMEOUT_MS, killGraceMs = START_KILL_GRACE_MS): Promise<StartResult> {
  return new Promise((resolve) => {
    let stderr = "";
    const windows = process.platform === "win32";
    const child = windows
      ? spawn("cmd.exe", cmdArguments(command), { stdio: ["pipe", "ignore", "pipe"], windowsVerbatimArguments: true, windowsHide: true })
      : spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "ignore", "pipe"], detached: true });
    let killer: NodeJS.Timeout | undefined;
    let killed = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (windows) {
        killed = true;
        if (child.pid !== undefined) killTree(child.pid);
        return;
      }
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      signalGroup("SIGTERM");
      if (!windows) killer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    }, timeoutMs);
    child.stdin.on("error", () => {
      // A command that does not read its input closes the pipe early; its exit status is what counts.
    });
    child.stdin.end(`${JSON.stringify(handoff)}\n`);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ exit: null, error: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        // A process the command left running may hold its error output open; entail stops listening.
        child.stderr.destroy();
        if (code === 0) resolve({ exit: 0 });
        else resolve({ exit: killed ? null : code, error: signal !== null ? `stopped by ${signal}` : killed ? "stopped by taskkill" : `exited ${code}${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 500)}`}` });
      };
      // What the shell wrote just before it exited is read before the result is given.
      if (child.stderr.readableEnded) return done();
      const grace = setTimeout(done, 100);
      child.stderr.once("end", () => {
        clearTimeout(grace);
        done();
      });
    });
  });
}
