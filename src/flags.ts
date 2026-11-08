import type { BoardItemSnapshot } from "./board-item.ts";
import { criteriaInForce, type CriteriaDetail } from "./criteria.ts";
import type { Git } from "./git.ts";
import type { CallRecord, RepoRecord, Store, TicketRecord, VisionChangeRecord } from "./store.ts";
import { blobAt, visionChangesInForce } from "./vision-change.ts";
import { collapseWhitespace, computeVisionChange, readVision, visionLinesOf, type VisionLine } from "./vision.ts";

/**
 * Which tickets a vision change flags (spec §12, ADR-0016), and which open
 * board items it touches (spec §13, ADR-0008).
 *
 * - A vision change flags a cleared or landing ticket whose clear came from
 *   an automatic verdict (settled or unopposed) when any line was added, or a
 *   line its call cites was removed. A ticket cleared by the owner's answer
 *   is not flagged by a vision change, and nothing else is.
 * - A ticket stays flagged until a re-check is recorded at a vision that
 *   holds every change so far. Its flag is worked out against the vision its
 *   latest judgment read (its clear, or its latest re-check), so a second
 *   change before the re-check is recorded is judged with the first.
 * - An open board item is touched when a line was added, or a line of its
 *   vision check was removed or reworded.
 */

/** The lines one or more vision changes removed and added, net, by text. */
export interface LinesChanged {
  removed: readonly string[];
  added: readonly string[];
}

/** What a ticket's flag is judged on: its state, how it was cleared, and the lines its call cites. */
export interface FlagBasis {
  state: TicketRecord["state"];
  /** Whether its clear came from an automatic verdict (settled or unopposed), not the owner's answer. */
  automatic: boolean;
  /** The vision lines its call cites, word for word; none for an unopposed clear. */
  cited: readonly string[];
}

/**
 * The flag lookup (ADR-0016): whether a vision change flags a ticket. Only a
 * cleared or landing ticket cleared by an automatic verdict is flagged, when
 * a line was added or a line its call cites was removed. Lines are compared
 * by identity, with whitespace collapsed (ADR-0003).
 */
export function visionChangeFlags(basis: FlagBasis, change: LinesChanged): boolean {
  if (basis.state !== "cleared" && basis.state !== "landing") return false;
  if (!basis.automatic) return false;
  if (change.added.length > 0) return true;
  const cited = new Set(basis.cited.map(collapseWhitespace));
  return change.removed.some((line) => cited.has(collapseWhitespace(line)));
}

/** Whether a vision change touches an open board item: a line was added, or a line its vision check quotes was removed (spec §13). */
export function visionChangeTouchesItem(checked: readonly string[], change: LinesChanged): boolean {
  if (change.added.length > 0) return true;
  const lines = new Set(checked.map(collapseWhitespace));
  return change.removed.some((line) => lines.has(collapseWhitespace(line)));
}

/** The call kinds whose call is a ticket's latest judgment at a vision: a clear, a new criteria version or a re-check. */
function isJudgment(call: CallRecord): boolean {
  if (call.kind === "recheck") return (call.detail as { recheck?: unknown } | null)?.recheck !== undefined;
  const detail = call.detail as Partial<CriteriaDetail> | null;
  return call.kind === "criteria" && detail?.outcome === "criteria" && typeof detail.version === "number";
}

/** The ticket's latest judgment at a vision, which a flag is worked out against: its clear, a later criteria version or its latest re-check. */
export function latestJudgment(calls: readonly CallRecord[]): CallRecord | null {
  return calls.findLast(isJudgment) ?? null;
}

/** What a cleared or landing ticket's flag is judged on, from its records; null when it has no criteria in force. */
export function flagBasisOf(ticket: TicketRecord, calls: readonly CallRecord[]): (FlagBasis & { judgment: CallRecord; visionSha: string }) | null {
  const criteria = criteriaInForce(calls);
  const judgment = latestJudgment(calls);
  const visionSha = judgment?.inputs?.visionSha ?? null;
  if (criteria === null || judgment === null || visionSha === null) return null;
  const answered = (criteria.answerIds?.length ?? 0) > 0 || (criteria.goAheadCallId ?? null) !== null;
  return { state: ticket.state, automatic: !answered, cited: judgment.citation?.lines ?? [], judgment, visionSha };
}

/** A ticket flagged by vision changes, with what it is re-checked on. */
export interface VisionFlag {
  ticketId: number;
  /** The judgment the flag is against, which the re-check is given as the prior call. */
  judgmentCallId: number;
  /** The vision its judgment read, and the vision of record now. */
  fromSha: string;
  toSha: string;
  /** Every vision change since the judgment, oldest first. */
  changes: VisionChangeRecord[];
  /** The lines removed and added across all of them, net, at those two visions. */
  removed: VisionLine[];
  added: VisionLine[];
}

/** An open board item touched by vision changes since it was raised. */
export interface TouchedItem {
  ticketId: number;
  boardItemId: number;
  fromSha: string;
  toSha: string;
  changes: VisionChangeRecord[];
  removed: VisionLine[];
  added: VisionLine[];
}

/** Works out flags from the records and the repo's git mirror; a commit's VISION.md blob is read once. */
export class VisionFlags {
  readonly #store: Store;
  readonly #git: (repo: RepoRecord) => Promise<Git>;
  readonly #blobs = new Map<string, Promise<string | null>>();
  readonly #lines = new Map<string, Promise<VisionLine[] | null>>();
  /** The flags and touched items the latest refresh of each repo found, by ticket id. */
  readonly #flags = new Map<number, VisionFlag>();
  readonly #touched = new Map<number, TouchedItem>();

  constructor(options: { store: Store; git: (repo: RepoRecord) => Promise<Git> }) {
    this.#store = options.store;
    this.#git = options.git;
  }

  /** The ticket's flag as the latest refresh of its repo found it, or null. Steps check it afresh with {@link VisionFlags.flagOf}. */
  flag(ticketId: number): VisionFlag | null {
    return this.#flags.get(ticketId) ?? null;
  }

  /** The ticket's open board item touched by a vision change, as the latest refresh found it, or null. */
  touched(ticketId: number): TouchedItem | null {
    return this.#touched.get(ticketId) ?? null;
  }

  /** Forgets what is known of a ticket's flag, as after its re-check is recorded. */
  forget(ticketId: number): void {
    this.#flags.delete(ticketId);
    this.#touched.delete(ticketId);
  }

  /** Works out every in-flight ticket of the repo afresh: its flag, or its open board item touched. */
  async refresh(repo: RepoRecord): Promise<void> {
    for (const ticket of this.#store.ticketsInFlight(repo.id)) {
      if (ticket.state === "cleared" || ticket.state === "landing") {
        const flag = await this.flagOf(repo, ticket);
        if (flag === null) this.#flags.delete(ticket.id);
        else this.#flags.set(ticket.id, flag);
      } else {
        this.#flags.delete(ticket.id);
      }
      if (ticket.state === "on-the-board") {
        const touched = await this.touchedOf(repo, ticket);
        if (touched === null) this.#touched.delete(ticket.id);
        else this.#touched.set(ticket.id, touched);
      } else {
        this.#touched.delete(ticket.id);
      }
    }
  }

  /** The ticket's flag, read afresh from the records, or null when it is not flagged. */
  async flagOf(repo: RepoRecord, ticket: TicketRecord): Promise<VisionFlag | null> {
    if (ticket.state !== "cleared" && ticket.state !== "landing") return null;
    const basis = flagBasisOf(ticket, this.#store.callsForTicket(ticket.id));
    if (basis === null || !basis.automatic) return null;
    const since = await this.#since(repo, basis.visionSha, basis.judgment.madeAt);
    if (since === null || !visionChangeFlags(basis, lineTexts(since))) return null;
    return { ticketId: ticket.id, judgmentCallId: basis.judgment.id, ...since };
  }

  /** The ticket's open board item, when a vision change since it was raised touches it, or null. */
  async touchedOf(repo: RepoRecord, ticket: TicketRecord): Promise<TouchedItem | null> {
    if (ticket.state !== "on-the-board") return null;
    const item = this.#store.openBoardItem(ticket.id);
    if (item === null) return null;
    const check = (item.snapshot as Partial<BoardItemSnapshot> | null)?.visionCheck;
    if (check === undefined || typeof check.commit !== "string") return null;
    const since = await this.#since(repo, check.commit, item.raisedAt);
    if (since === null) return null;
    const checked = [...check.lines.map((line) => line.text), ...check.unquotable.map((line) => line.line)];
    if (!visionChangeTouchesItem(checked, lineTexts(since))) return null;
    return { ticketId: ticket.id, boardItemId: item.id, ...since };
  }

  /**
   * The vision changes recorded after the vision at `fromSha`, and the lines
   * they removed and added, net; null when there are none. The changes are
   * found by VISION.md's blob at `fromSha`; when no recorded change or the
   * enrollment has that blob, by the time the judgment was made.
   */
  async #since(repo: RepoRecord, fromSha: string, madeAt: string): Promise<Omit<VisionFlag, "ticketId" | "judgmentCallId"> | null> {
    const chain = visionChangesInForce(this.#store, repo.id);
    if (chain.length === 0) return null;
    const git = await this.#git(repo);
    const blob = await this.#blobAt(git, fromSha);
    let changes: VisionChangeRecord[];
    const at = blob === null ? -1 : chain.findLastIndex((change) => change.blobSha === blob);
    if (at >= 0) changes = chain.slice(at + 1);
    else {
      const enrollment = this.#store.latestEnrollment(repo.id);
      const enrolled = enrollment === null ? null : await this.#blobAt(git, enrollment.visionSha);
      changes = blob !== null && enrolled === blob ? chain : chain.filter((change) => change.seenAt >= madeAt);
    }
    const latest = changes.at(-1);
    if (latest === undefined) return null;
    const [before, after] = [await this.#linesAt(git, fromSha), await this.#linesAt(git, latest.commitSha)];
    // A vision that cannot be read changed in ways entail cannot list: every line now counts as added.
    const net = computeVisionChange(before ?? [], after ?? []);
    return { fromSha, toSha: latest.commitSha, changes, removed: net.removed, added: net.added };
  }

  #blobAt(git: Git, commit: string): Promise<string | null> {
    let found = this.#blobs.get(commit);
    if (found === undefined) {
      found = blobAt(git, commit);
      this.#blobs.set(commit, found);
    }
    return found;
  }

  #linesAt(git: Git, commit: string): Promise<VisionLine[] | null> {
    let found = this.#lines.get(commit);
    if (found === undefined) {
      found = readVision(git, commit).then(visionLinesOf, () => null);
      this.#lines.set(commit, found);
    }
    return found;
  }
}

function lineTexts(change: { removed: readonly VisionLine[]; added: readonly VisionLine[] }): LinesChanged {
  return { removed: change.removed.map((line) => line.text), added: change.added.map((line) => line.text) };
}
