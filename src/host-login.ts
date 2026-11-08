import { ForgeLoggedOutError, type Forge } from "./forge/forge.ts";
import type { RepoRecord } from "./store.ts";

/** A host whose CLI cannot act as the owner: the host's halt (spec §16, ADR-0019). */
export interface HostLoginProblem {
  problem: "logged-out" | "other-account";
  /** What the check saw, for the strip and the operational log. */
  detail: string;
}

/** What one check of a host's login found: fine, a halt, or nothing known because the read failed. */
export type HostLoginCheck = { status: "ok" } | ({ status: "halted" } & HostLoginProblem) | { status: "unknown"; error: string };

/** The CLI entail acts through on a forge. */
export function cliOf(repo: Pick<RepoRecord, "forge">): "gh" | "glab" {
  return repo.forge === "github" ? "gh" : "glab";
}

/** One key per forge host: `<forge>:<host>`. */
export function hostKey(repo: Pick<RepoRecord, "forge" | "host">): string {
  return `${repo.forge}:${repo.host}`;
}

/**
 * Checks that the host's CLI is logged in as the account recorded when its
 * repos were enrolled (spec §1 "Start" step 4, ADR-0015), compared by numeric
 * id. Every repo given must be on the forge's host. A logged-out CLI, or one
 * logged in as anyone else, halts the host; a read that fails otherwise
 * tells nothing, and the host's polls show whether it answers.
 */
export async function checkHostLogin(forge: Forge, repos: readonly RepoRecord[]): Promise<HostLoginCheck> {
  const first = repos[0];
  if (first === undefined) return { status: "ok" };
  const cli = cliOf(first);
  let current;
  try {
    current = await forge.currentActor();
  } catch (error) {
    if (error instanceof ForgeLoggedOutError) return { status: "halted", problem: "logged-out", detail: `${cli} is not logged in to ${first.host}` };
    return { status: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
  if (current === null) return { status: "halted", problem: "logged-out", detail: `${cli} is not logged in to ${first.host}` };
  const other = repos.find((repo) => repo.ownerAccountId !== current.id);
  if (other !== undefined) {
    return {
      status: "halted",
      problem: "other-account",
      detail: `${cli} is logged in to ${first.host} as ${current.username}, not ${other.ownerLogin}, the account ${other.path} was enrolled with`,
    };
  }
  return { status: "ok" };
}
