import type { Change } from "./forge/forge.ts";

/**
 * Drops changes the core has already seen. A change is known by its kind, id
 * and update time: an adapter may report the same change again, as
 * a cursor's overlap does, and it passes through only once, while a later
 * update to the same issue or comment passes through again. A copy older than
 * one already seen is stale and is dropped too.
 *
 * What it has seen is kept in memory: like the cursors, it is operational
 * state, and losing it on a restart costs only a re-scan.
 */
export class ChangeDeduplicator {
  /** The newest update time seen for each kind and id, as epoch milliseconds. */
  readonly #newest = new Map<string, number>();

  /** The changes not seen before, in the order given, now remembered as seen. */
  fresh(changes: readonly Change[]): Change[] {
    const fresh: Change[] = [];
    for (const change of changes) {
      const key = `${change.kind}:${change.id}`;
      const updated = Date.parse(change.updatedAt);
      const seen = this.#newest.get(key);
      if (seen !== undefined && updated <= seen) continue;
      this.#newest.set(key, updated);
      fresh.push(change);
    }
    return fresh;
  }
}
