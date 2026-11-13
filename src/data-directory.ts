import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Where entail keeps its data on this machine. */
export interface DataDirectoryInputs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * The data directory holds each repo's log of calls and answers, the
 * owner's case book, the settings and pins, the git mirrors and their
 * read-only checkouts, the change cursors, the operational log and the lock.
 *
 * - Linux and WSL: `$XDG_DATA_HOME/entail`, by default `~/.local/share/entail`.
 * - macOS: `~/Library/Application Support/entail`.
 * - Windows: `%LOCALAPPDATA%\entail`, by default `~\AppData\Local\entail`.
 *
 * A relative `XDG_DATA_HOME` or `LOCALAPPDATA` is ignored, as the XDG Base
 * Directory specification requires. Paths are built for the platform named,
 * whichever machine resolves them.
 */
export function resolveDataDirectory(inputs: DataDirectoryInputs): string {
  const { platform, env, home } = inputs;
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "entail");
  }
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "share");
    return posix.join(base, "entail");
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && win32.isAbsolute(local) ? local : win32.join(home, "AppData", "Local");
    return win32.join(base, "entail");
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
    super(`entail supports Linux (WSL included), macOS and Windows, not ${platform}`);
    this.name = "UnsupportedPlatformError";
  }
}
