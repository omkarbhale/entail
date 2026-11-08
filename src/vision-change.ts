import type { Git } from "./git.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { RepoRecord, Store, VisionChangeRecord } from "./store.ts";
import { readAddedLineOrigins, type LineOrigin } from "./vision-origin.ts";
import { computeVisionChange, readVision, VISION_PATH, visionLinesOf, type VisionLine } from "./vision.ts";

/**
 * Watching the vision of record (spec §4, ADR-0003, ADR-0004, ADR-0016,
 * ADR-0019).
 *
 * - **A vision change.** Each new VISION.md blob on the default branch is
 *   recorded as a vision change: the vision lines it removed and added since
 *   the vision of record before it, compared by identity (a reworded line is
 *   one removed and one added). A blob that moves lines or renames headings
 *   is still a vision change, one that removes and adds nothing.
 * - **Origins.** Each added line's origin is read from the `Vision-Origin:`
 *   trailer of the commit that added it, and recorded with the change, in one
 *   transaction. A missing trailer, or an unknown value, records the line as
 *   stated by the owner, keeping the raw trailer.
 * - **A vanished vision.** While VISION.md is gone from the default branch or
 *   empty, nothing is recorded; the pass halts what is decided and landed in
 *   the repo. Once a vision is back, the change is recorded against the last
 *   vision of record.
 *
 * The vision of record a change is computed from is the repo's latest
 * recorded vision change since its latest enrollment, or the VISION.md the
 * owner reviewed at that enrollment.
 */

/** Where the watch reads VISION.md and its history: a git mirror of the repo. */
export interface VisionMirror {
  readonly git: Git;
}

/** VISION.md as the watch found it on the default branch. */
export type VisionStanding =
  | { status: "present"; commit: string; blob: string; lines: VisionLine[]; recorded: VisionChangeRecord | null }
  /** Gone or empty: the repo is halted until a vision is back. */
  | { status: "gone"; commit: string; why: string };

/** The vision of record a change is computed from. */
interface VisionOfRecord {
  commit: string;
  /** Its VISION.md blob, or null when it cannot be read. */
  blob: string | null;
}

export interface VisionWatchOptions {
  store: Store;
  log: OperationalLog;
  dataDirectory: string;
  /** The repo's mirror; its git mirror in the data directory by default. */
  mirrorFor?: (repo: RepoRecord) => Promise<VisionMirror>;
}

/** The halt a gone or empty VISION.md puts on its repo, in the words health shows (ADR-0019). */
export function visionHaltText(status: "missing" | "empty"): string {
  return status === "missing"
    ? `${VISION_PATH} is gone from the default branch, so nothing new is decided or landed in this repo until a vision is back.`
    : `${VISION_PATH} is empty on the default branch, so nothing new is decided or landed in this repo until a vision is back.`;
}

/**
 * The watch over every enrolled repo's VISION.md. What it records is records;
 * the halt and the vision of record of a repo with no enrollment recorded are
 * kept in memory, and the next pass works them out again.
 */
export class VisionWatch {
  readonly #store: Store;
  readonly #log: OperationalLog;
  readonly #mirrorFor: (repo: RepoRecord) => Promise<VisionMirror>;
  readonly #mirrors = new Map<number, Promise<VisionMirror>>();
  /** Per repo with neither an enrollment nor a vision change recorded, the vision first seen by this process. */
  readonly #firstSeen = new Map<number, VisionOfRecord>();
  /** Per halted repo, why. */
  readonly #halted = new Map<number, string>();

  constructor(options: VisionWatchOptions) {
    this.#store = options.store;
    this.#log = options.log;
    this.#mirrorFor =
      options.mirrorFor ??
      ((repo) =>
        Mirror.open({
          dataDirectory: options.dataDirectory,
          key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
          remote: forgeRemote(repo.forge, repo.host, repo.path),
          log: options.log,
        }));
  }

  /** The repo's mirror, opened once. */
  mirror(repo: RepoRecord): Promise<VisionMirror> {
    let found = this.#mirrors.get(repo.id);
    if (!found) {
      found = this.#mirrorFor(repo);
      found.catch(() => this.#mirrors.delete(repo.id));
      this.#mirrors.set(repo.id, found);
    }
    return found;
  }

  /** Why the repo is halted for its vision, or null when it is not. */
  halted(repoId: number): string | null {
    return this.#halted.get(repoId) ?? null;
  }

  /**
   * Reads VISION.md at a commit of the default branch, records it as a vision
   * change with the origins of the lines it added when its blob is new, and
   * says whether the repo has a vision there.
   */
  async observe(repo: RepoRecord, commit: string): Promise<VisionStanding> {
    const { git } = await this.mirror(repo);
    const vision = await readVision(git, commit);
    // The pass logs and shows the repo's vision halt (spec §16); the watch only remembers it, so nothing merges meanwhile.
    if (vision.status !== "present") {
      const why = visionHaltText(vision.status);
      this.#halted.set(repo.id, why);
      return { status: "gone", commit: vision.commit, why };
    }
    this.#halted.delete(repo.id);

    const before = await this.#visionOfRecord(repo, git, vision.commit, vision.blob);
    if (before.blob === vision.blob) return { status: "present", commit: vision.commit, blob: vision.blob, lines: vision.lines, recorded: null };

    const beforeLines = await linesAt(git, before.commit);
    const change = computeVisionChange(beforeLines ?? [], vision.lines);
    const origins = beforeLines === null ? change.added.map(ownerStated) : await readAddedLineOrigins(git, before.commit, vision.commit).catch(() => change.added.map(ownerStated));
    const byIdentity = new Map(origins.map((origin) => [origin.line.identity, origin]));

    const recorded = this.#store.transaction(() => {
      // Another pass of this process may have recorded the same blob meanwhile.
      if (this.#latestChange(repo.id)?.blobSha === vision.blob) return null;
      const row = this.#store.recordVisionChange({
        repoId: repo.id,
        commitSha: vision.commit,
        blobSha: vision.blob,
        previousBlobSha: before.blob,
        removed: change.removed.map((line) => line.text),
        added: change.added.map((line) => line.text),
      });
      for (const line of change.added) {
        const origin = byIdentity.get(line.identity) ?? ownerStated(line);
        this.#store.recordVisionLineOrigin({
          repoId: repo.id,
          line: line.identity,
          origin: origin.origin,
          commitSha: origin.commit ?? vision.commit,
          source: origin.commit !== null && origin.rawTrailer !== null ? "trailer" : "no-trailer",
          rawTrailer: origin.rawTrailer,
        });
      }
      return row;
    });
    this.#firstSeen.delete(repo.id);
    if (recorded !== null) {
      this.#log.info("vision-change", {
        repoId: repo.id,
        visionChangeId: recorded.id,
        commit: vision.commit,
        removed: recorded.removed.length,
        added: recorded.added.length,
        baseReadable: beforeLines !== null,
      });
    }
    return { status: "present", commit: vision.commit, blob: vision.blob, lines: vision.lines, recorded };
  }

  /** The repo's latest vision change since its latest enrollment, or null. */
  #latestChange(repoId: number): VisionChangeRecord | null {
    return visionChangesInForce(this.#store, repoId).at(-1) ?? null;
  }

  async #visionOfRecord(repo: RepoRecord, git: Git, commit: string, blob: string): Promise<VisionOfRecord> {
    const latest = this.#latestChange(repo.id);
    if (latest !== null) return { commit: latest.commitSha, blob: latest.blobSha };
    const enrollment = this.#store.latestEnrollment(repo.id);
    if (enrollment !== null) return { commit: enrollment.visionSha, blob: await blobAt(git, enrollment.visionSha) };
    // A repo enrolled before enrollments were recorded: its first vision seen is its vision of record.
    let first = this.#firstSeen.get(repo.id);
    if (first === undefined) {
      first = { commit, blob };
      this.#firstSeen.set(repo.id, first);
      this.#log.warn("vision-of-record-unknown", { repoId: repo.id, commit });
    }
    return first;
  }
}

/** A repo's vision changes since its latest enrollment, oldest first: the ones that make its current vision of record. */
export function visionChangesInForce(store: Store, repoId: number): VisionChangeRecord[] {
  return store.visionChanges(repoId, store.latestEnrollment(repoId)?.enrolledAt);
}

/** VISION.md's blob at a commit, or null when it has none or the commit cannot be read. */
export async function blobAt(git: Git, commit: string): Promise<string | null> {
  try {
    const vision = await readVision(git, commit);
    return vision.status === "missing" ? null : vision.blob;
  } catch {
    return null;
  }
}

/** The vision lines at a commit, none when VISION.md is gone or empty there, or null when the commit cannot be read. */
async function linesAt(git: Git, commit: string): Promise<VisionLine[] | null> {
  try {
    return visionLinesOf(await readVision(git, commit));
  } catch {
    return null;
  }
}

/** A line with no recorded origin: stated by the owner (ADR-0004). */
function ownerStated(line: VisionLine): LineOrigin {
  return { line, origin: "owner-stated", commit: null, rawTrailer: null };
}
