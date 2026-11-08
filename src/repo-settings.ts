import { MERGE_METHODS, type MergeMethod } from "./forge/forge.ts";
import type { VisionOrigin } from "./store.ts";

/**
 * Who counts as an executor in a repo (ADR-0013): anyone, or only the owner
 * plus the executors listed for it.
 */
export type WhoCounts = "anyone" | "owner-and-listed";

/**
 * One enrolled repo's settings, kept in entail's records as versions, never in
 * the repo (spec §15, ADR-0018). The forge itself (`forge`, `host`, `path`) is
 * fixed at enrollment and kept on the repo's record, not here.
 */
export interface RepoSettings {
  /** The origin the owner confirmed for the VISION.md that existed at enrollment (ADR-0004). */
  visionOrigin: VisionOrigin;
  /** GitHub's merge method; null on GitLab, where the project's own merge method applies. */
  mergeMethod: MergeMethod | null;
  /** The confirmed generic criteria G1…Gn, which may be empty. */
  genericCriteria: unknown[];
  /** Off by default: when on, entail decides and checks but does not merge. */
  shadow: boolean;
  whoCounts: WhoCounts;
  /** The executors counted when only the owner and listed executors count. */
  executors: unknown[];
  /** The pins beyond the built-in VISION.md pin, which is never listed and cannot be removed. */
  pins: unknown[];
  paused: boolean;
}

/** The origin preselected for the existing VISION.md, because a vision is first written with /vision (ADR-0018). */
export const PRESELECTED_VISION_ORIGIN: VisionOrigin = "agent-proposed-owner-approved";

/**
 * The settings a repo is enrolled with: the owner's confirmed origin and
 * merge method, an empty generic criteria list, and the defaults: shadow off,
 * who counts set to anyone, and no pins beyond VISION.md (ADR-0018).
 */
export function enrollmentSettings(visionOrigin: VisionOrigin, mergeMethod: MergeMethod | null): RepoSettings {
  return {
    visionOrigin,
    mergeMethod,
    genericCriteria: [],
    shadow: false,
    whoCounts: "anyone",
    executors: [],
    pins: [],
    paused: false,
  };
}

/**
 * The merge method preselected on GitHub (ADR-0018): the one allowed method,
 * or squash if several are allowed, else the first allowed of merge commit and
 * rebase. When GitHub did not say which are allowed, squash.
 */
export function preselectedMergeMethod(allowed: readonly MergeMethod[]): MergeMethod {
  if (allowed.length === 1) return allowed[0]!;
  if (allowed.length === 0 || allowed.includes("squash")) return "squash";
  return (["merge", "rebase"] as const).find((method) => allowed.includes(method))!;
}

/** How each merge method is named to the owner. */
export const MERGE_METHOD_LABELS: Readonly<Record<MergeMethod, string>> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

export function isMergeMethod(value: string): value is MergeMethod {
  return (MERGE_METHODS as readonly string[]).includes(value);
}
