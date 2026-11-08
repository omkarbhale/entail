import { spawn } from "node:child_process";

/**
 * Environment variables that point git at a repository other than the one
 * named, as `git rev-parse --local-env-vars` lists them. They are dropped so
 * that entail always reads the repository it names, even when it runs under a
 * git hook that sets them.
 */
const REPOSITORY_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/**
 * Settings that keep git's output the same whatever the owner's own git
 * configuration says, so that entail parses what it expects.
 */
const STABLE_OUTPUT_CONFIG = ["log.showSignature=false", "core.quotePath=false", "color.ui=false", "diff.noprefix=false"];

export interface GitRunOptions {
  /** Extra environment variables for this one command. */
  env?: Record<string, string>;
  /** Exit codes other than 0 that are answers rather than failures. */
  okExitCodes?: number[];
}

export interface GitResult {
  stdout: Buffer;
  exitCode: number;
}

/** A git command that failed; it is a machine failure, never a product one. */
export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string, cause?: unknown) {
    const trimmed = stderr.trim();
    super(`git ${args.join(" ")} failed${exitCode === null ? "" : ` with exit code ${exitCode}`}${trimmed ? `: ${trimmed}` : ""}`, {
      cause,
    });
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * One git repository on this machine, read by running the `git` command.
 *
 * Output is collected whole, never truncated, and every command runs without
 * a terminal prompt.
 */
export class Git {
  readonly gitDir: string;
  readonly #config: string[];

  /**
   * @param gitDir the repository's git directory (a bare mirror's own path).
   * @param config extra `-c name=value` settings for every command.
   */
  constructor(gitDir: string, config: string[] = []) {
    this.gitDir = gitDir;
    this.#config = config;
  }

  /** Runs `git <args>` in this repository and returns its output. */
  run(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
    const fullArgs = [
      ...[...STABLE_OUTPUT_CONFIG, ...this.#config].flatMap((setting) => ["-c", setting]),
      `--git-dir=${this.gitDir}`,
      ...args,
    ];
    return runGit(fullArgs, args, options);
  }

  /** Runs `git <args>` and returns its standard output as UTF-8 text. */
  async text(args: string[], options: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf8");
  }
}

function runGit(fullArgs: string[], shownArgs: string[], options: GitRunOptions): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPOSITORY_ENV_VARS) delete env[name];
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" }, options.env);
  const okExitCodes = [0, ...(options.okExitCodes ?? [])];

  return new Promise((resolve, reject) => {
    const child = spawn("git", fullArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => reject(new GitError(shownArgs, null, error.message, error)));
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (okExitCodes.includes(exitCode)) {
        resolve({ stdout: Buffer.concat(stdout), exitCode });
      } else {
        reject(new GitError(shownArgs, code, Buffer.concat(stderr).toString("utf8")));
      }
    });
  });
}
