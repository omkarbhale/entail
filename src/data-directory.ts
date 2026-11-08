import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Where entail keeps its data on this machine. */
export interface DataDirectoryInputs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * The data directory holds the store, the records repo, the git mirrors, the
 * operational log, the status file and the lock (ADR-0017, ADR-0019).
 *
 * - Linux and WSL: `$XDG_DATA_HOME/entail`, by default `~/.local/share/entail`.
 * - macOS: `~/Library/Application Support/entail`.
 *
 * Native Windows is not supported. A relative `XDG_DATA_HOME` is ignored, as
 * the XDG Base Directory specification requires.
 */
export function resolveDataDirectory(inputs: DataDirectoryInputs): string {
  const { platform, env, home } = inputs;
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "entail");
  }
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
    return join(base, "entail");
  }
  throw new UnsupportedPlatformError(platform);
}

/** Resolves this machine's data directory and creates it if it is missing. */
export function ensureDataDirectory(
  inputs: DataDirectoryInputs = { platform: process.platform, env: process.env, home: homedir() },
): string {
  const dir = resolveDataDirectory(inputs);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`entail supports Linux (WSL included) and macOS, not ${platform}`);
    this.name = "UnsupportedPlatformError";
  }
}
