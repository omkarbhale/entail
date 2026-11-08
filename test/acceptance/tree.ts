// Moving a repo tree between memory, a directory and git, and running its tests.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXECUTABLE_FILES, type Tree } from "./fixture.ts";

/** Runs git in a directory and returns its standard output; throws on failure. */
export function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Reads the files git tracks in a working tree. */
export function readTree(directory: string): Tree {
  const tree: Tree = new Map();
  const paths = git(directory, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of paths) tree.set(path, readFileSync(join(directory, path), "utf8"));
  return tree;
}

/**
 * Makes a working tree hold exactly `tree`: writes every file (executable
 * where tally's are), and deletes tracked files the tree no longer has.
 */
export function writeTree(directory: string, tree: Tree, previous?: Tree): void {
  for (const path of previous?.keys() ?? []) {
    if (!tree.has(path)) rmSync(join(directory, path), { force: true });
  }
  for (const [path, text] of tree) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    if (EXECUTABLE_FILES.has(path)) chmodSync(target, 0o755);
  }
}

export interface TestRun {
  passed: boolean;
  /** How many tests passed and failed, from node's summary. */
  pass: number;
  fail: number;
  output: string;
}

/** Runs tally's `npm test` (`node --test`) in a directory. */
export function runTests(directory: string): TestRun {
  // Run as a fresh `npm test` would, not as a child of whatever test runner
  // started the harness (node:test marks its children through the environment).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_TEST")));
  const result = spawnSync(process.execPath, ["--test"], { cwd: directory, encoding: "utf8", env, timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const count = (name: string) => Number(new RegExp(`^ℹ ${name} (\\d+)$`, "m").exec(output)?.[1] ?? 0);
  return { passed: result.status === 0, pass: count("pass"), fail: count("fail"), output };
}
