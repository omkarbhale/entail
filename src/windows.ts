import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * What native Windows needs where entail runs other programs: the owner's
 * commands go through `cmd.exe` where Unix uses `/bin/sh`, a batch file such
 * as npm's `claude.cmd` can only be run through `cmd.exe`, and a command is
 * stopped with its whole process tree by `taskkill`, since Windows has no
 * process groups.
 */

/** The arguments that make `cmd.exe` run one command line exactly as given (`/s` drops only the outer quotes). */
export function cmdArguments(commandLine: string): string[] {
  return ["/d", "/s", "/c", `"${commandLine}"`];
}

/** cmd.exe's metacharacters, each escaped with `^` so cmd.exe passes it on as written. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;

/**
 * One argument on a command line run through `cmd.exe`: quoted for the
 * program's own argument parser, then escaped for `cmd.exe`, twice for a
 * batch file, whose arguments `cmd.exe` reads a second time.
 */
export function cmdArgument(value: string, batch: boolean): string {
  const quoted = `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1")}"`.replace(CMD_META, "^$1");
  return batch ? quoted.replace(CMD_META, "^$1") : quoted;
}

/** How to start a program on Windows: the file to spawn, its arguments, and whether they are passed verbatim. */
export interface WindowsCommand {
  file: string;
  args: string[];
  verbatim: boolean;
}

/**
 * How to run `command` with `args` on Windows. Node starts an `.exe` found on
 * the PATH by name, but not a batch file such as the `claude.cmd` npm
 * installs, so a batch file found on the PATH (by `PATHEXT`) runs through
 * `cmd.exe` with every argument escaped for it.
 */
export function windowsCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv): WindowsCommand {
  const found = findOnPath(command, env);
  if (found === null || !/\.(cmd|bat)$/iu.test(found)) return { file: found ?? command, args: [...args], verbatim: false };
  const line = [found.replace(CMD_META, "^$1"), ...args.map((arg) => cmdArgument(arg, true))].join(" ");
  return { file: "cmd.exe", args: cmdArguments(line), verbatim: true };
}

/** Where `command` is, searched as Windows does: as a path when it has one, else in each PATH directory, with each `PATHEXT` extension. */
function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const variable = (name: string) => env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name];
  const extensions = (variable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "");
  const candidates = (base: string) => (extname(command) !== "" ? [base] : extensions.map((ext) => base + ext.toLowerCase()));
  const directories = /[\\/]/u.test(command) ? [""] : (variable("PATH") ?? "").split(";").filter((dir) => dir !== "");
  for (const directory of directories) {
    for (const candidate of candidates(directory === "" ? command : join(directory, command))) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Stops a process and every process it started, as `kill(-pgid)` does on Unix. */
export function killTree(pid: number): void {
  spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {
    // Nothing more to stop it with.
  });
}
