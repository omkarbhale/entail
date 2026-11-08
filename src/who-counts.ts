import { sameActor, type Actor } from "./forge/forge.ts";
import { repoOwner } from "./intake.ts";
import type { RepoSettings } from "./repo-settings.ts";
import type { RepoRecord } from "./store.ts";

/**
 * Whether an account counts as an executor in a repo (ADR-0013, ADR-0018).
 * Under "anyone", every account does. Under "owner plus listed executors",
 * only the owner's own account and the executors listed in the repo's
 * settings do, compared by numeric id, never by username.
 */
export function countsAsExecutor(repo: RepoRecord, settings: Pick<RepoSettings, "whoCounts" | "executors">, account: Actor): boolean {
  if (settings.whoCounts !== "owner-and-listed") return true;
  if (sameActor(account, repoOwner(repo))) return true;
  return settings.executors.some((executor) => sameActor(executor, account));
}
