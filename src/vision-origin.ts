import type { Git } from "./git.ts";
import { computeVisionChange, readVision, VISION_PATH, visionLinesOf, type VisionLine } from "./vision.ts";

/** How a vision line came to be in the vision (ADR-0004). */
export const ORIGINS = ["owner-stated", "agent-proposed-owner-approved", "automatic-owner-notified"] as const;
export type Origin = (typeof ORIGINS)[number];

/** The commit trailer an agent writes to record the origin of the lines it adds. */
export const ORIGIN_TRAILER = "Vision-Origin";

/** The origin of one vision line, as read from the commit that added it. */
export interface LineOrigin {
  line: VisionLine;
  origin: Origin;
  /** The commit that added the line, or null if no commit in the range did. */
  commit: string | null;
  /**
   * The commit's `Vision-Origin:` trailer values as written, joined by
   * newlines, or null if it had none. Kept whatever the origin.
   */
  rawTrailer: string | null;
}

/**
 * The origin a commit's `Vision-Origin:` trailer values name. A missing
 * trailer, an unknown value, or values that disagree record the line as stated
 * by the owner (ADR-0004).
 */
export function originFromTrailer(values: string[]): { origin: Origin; rawTrailer: string | null } {
  const rawTrailer = values.length === 0 ? null : values.join("\n");
  const distinct = new Set(values.map((value) => value.trim()));
  const [only] = distinct;
  if (distinct.size === 1 && only !== undefined && isOrigin(only)) return { origin: only, rawTrailer };
  return { origin: "owner-stated", rawTrailer };
}

function isOrigin(value: string): value is Origin {
  return (ORIGINS as readonly string[]).includes(value);
}

/** Reads the `Vision-Origin:` trailer values of one commit. */
export async function readOriginTrailer(git: Git, commit: string): Promise<string[]> {
  const out = await git.text([
    "log",
    "-1",
    "--no-walk",
    `--format=%(trailers:key=${ORIGIN_TRAILER},valueonly,unfold,separator=%x00)`,
    "--end-of-options",
    commit,
  ]);
  return out
    .replace(/\n$/u, "")
    .split("\0")
    .filter((value) => value.trim() !== "");
}

/**
 * Reads the origin of every line the vision change from `from` to `to` adds.
 *
 * Each added line takes the trailer of the commit that added it: the last
 * commit between the two that brought the line into VISION.md (absent from
 * every parent, so a merge is not credited with its branch's lines). A
 * trailer applies to every line its commit adds (ADR-0004).
 */
export async function readAddedLineOrigins(git: Git, from: string, to: string): Promise<LineOrigin[]> {
  const [before, after] = await Promise.all([readVision(git, from), readVision(git, to)]);
  const { added } = computeVisionChange(visionLinesOf(before), visionLinesOf(after));
  if (added.length === 0) return [];

  const addedBy = await commitsAddingLines(git, before.commit, after.commit);
  const trailers = new Map<string, Promise<string[]>>();
  return Promise.all(
    added.map(async (line) => {
      const commit = addedBy.get(line.identity) ?? null;
      if (commit === null) return { line, origin: "owner-stated" as const, commit, rawTrailer: null };
      let values = trailers.get(commit);
      if (values === undefined) {
        values = readOriginTrailer(git, commit);
        trailers.set(commit, values);
      }
      return { line, commit, ...originFromTrailer(await values) };
    }),
  );
}

/** Maps each line identity to the last commit in `from..to` that added it. */
async function commitsAddingLines(git: Git, from: string, to: string): Promise<Map<string, string>> {
  // Oldest first, only the commits whose VISION.md differs from every parent's:
  // a commit with the same VISION.md as one parent adds no line.
  const touching = (
    await git.text(["rev-list", "--reverse", "--topo-order", "--full-history", to, `^${from}`, "--", VISION_PATH])
  )
    .split("\n")
    .filter((sha) => sha !== "");
  if (touching.length === 0) return new Map();
  // The same commits with their real parents, in the same order.
  const out = await git.text(["rev-list", "--no-walk=unsorted", "--parents", ...touching]);
  const identitiesAt = new Map<string, Promise<Set<string>>>();
  const identities = (commit: string): Promise<Set<string>> => {
    let found = identitiesAt.get(commit);
    if (found === undefined) {
      found = readVision(git, commit).then((vision) => new Set(visionLinesOf(vision).map((line) => line.identity)));
      identitiesAt.set(commit, found);
    }
    return found;
  };

  const addedBy = new Map<string, string>();
  for (const row of out.split("\n")) {
    const [commit, ...parents] = row.split(" ").filter((part) => part !== "");
    if (commit === undefined) continue;
    const [own, parentSets] = await Promise.all([identities(commit), Promise.all(parents.map(identities))]);
    for (const identity of own) {
      if (parentSets.every((set) => !set.has(identity))) addedBy.set(identity, commit);
    }
  }
  return addedBy;
}
