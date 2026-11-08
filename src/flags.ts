import type { BoardItemSnapshot } from "./board-item.ts";
import { criteriaInForce, type CriteriaDetail } from "./criteria.ts";
import { judgedPins, type JudgedPin } from "./decider.ts";
import type { Git } from "./git.ts";
import { readRepoSettings, repoSettingsOf } from "./repo-settings.ts";
import type { BoardItemRecord, CallRecord, RepoRecord, Store, TicketRecord, VisionChangeRecord } from "./store.ts";
import { blobAt, visionChangesInForce } from "./vision-change.ts";
import { collapseWhitespace, computeVisionChange, readVision, visionLinesOf, type VisionLine } from "./vision.ts";

/**
 * Which tickets a vision change or a pin change flags (spec §12, §15,
 * ADR-0016, ADR-0018), and which open board items they touch (spec §13,
 * ADR-0008).
 *
 * - A vision change flags a cleared or landing ticket whose clear came from
 *   an automatic verdict (settled or unopposed) when any line was added, or a
 *   line its call cites was removed. A ticket cleared by the owner's answer
 *   is not flagged by a vision change, and nothing else is.
 * - Adding a pin flags the same tickets the way an added line does: every
 *   cleared or landing ticket cleared by an automatic verdict. A pin is
 *   compared whole, so editing any part of one counts as removing the old pin
 *   and adding the new. Removing a pin flags nothing.
 * - A ticket stays flagged until a re-check is recorded at a vision and pins
 *   that hold every change so far. Its flag is worked out against the vision
 *   and pins its latest judgment read (its clear, or its latest re-check), so
 *   a second change before the re-check is recorded is judged with the first.
 * - An open board item is touched when a line was added, or a line of its
 *   vision check was removed or reworded; and when a pin was added, or a pin
 *   it names was removed or edited.
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

/** The pins one or more pin changes removed and added, net, compared whole. */
export interface PinsChanged {
  removed: readonly JudgedPin[];
  added: readonly JudgedPin[];
}

/**
 * A pin's identity: the whole pin, with whitespace collapsed and its paths and
 * keywords taken as sets. Editing any part of a pin makes a new identity, so
 * an edit is one pin removed and one added (ADR-0018).
 */
export function pinIdentity(pin: JudgedPin): string {
  const set = (values: readonly string[]) => [...new Set(values.map(collapseWhitespace).filter((v) => v !== ""))].sort();
  return JSON.stringify([collapseWhitespace(pin.topic), set(pin.paths), set(pin.keywords)]);
}

/** The pins removed and added between two lists of pins, compared whole. */
export function pinChange(before: readonly JudgedPin[], after: readonly JudgedPin[]): PinsChanged {
  const had = new Set(before.map(pinIdentity));
  const has = new Set(after.map(pinIdentity));
  return { removed: before.filter((pin) => !has.has(pinIdentity(pin))), added: after.filter((pin) => !had.has(pinIdentity(pin))) };
}

/**
 * Whether a pin change flags a ticket (spec §12, ADR-0018): adding any pin
 * flags a cleared or landing ticket cleared by an automatic verdict, as an
 * added vision line does. Removing a pin flags nothing.
 */
export function pinChangeFlags(basis: Pick<FlagBasis, "state" | "automatic">, change: PinsChanged): boolean {
  if (basis.state !== "cleared" && basis.state !== "landing") return false;
  if (!basis.automatic) return false;
  return change.added.length > 0;
}

/** Whether a pin change touches an open board item: a pin was added, or a pin it names was removed (spec §13, §15). */
export function pinChangeTouchesItem(named: readonly string[], change: PinsChanged): boolean {
  if (change.added.length > 0) return true;
  const topics = new Set(named.map(collapseWhitespace));
  return change.removed.some((pin) => topics.has(collapseWhitespace(pin.topic)));
}

/** The pins a board item names: the touched pins of why it was raised, and a landing pin item's pinned paths. */
export function pinsNamedBy(snapshot: Partial<BoardItemSnapshot> | null): string[] {
  const why = snapshot?.why;
  const named = [...(why?.pins ?? []).map((pin) => pin.pin), ...[...(why?.pinnedPaths ?? []), ...(snapshot?.landing?.paths ?? [])].map((path) => path.pin)];
  return [...new Set(named.map(collapseWhitespace))];
}

/**
 * The pins a call judged, VISION.md's first: the pins its inputs recorded, or
 * else the pins of the settings version it recorded; null when it recorded
 * neither, so no pin change can be worked out against it.
 */
export function pinsJudgedBy(store: Store, repoId: number, call: Pick<CallRecord, "inputs">): JudgedPin[] | null {
  const pins = call.inputs?.pins;
  if (Array.isArray(pins) && pins.every(isJudgedPin)) return pins;
  const id = call.inputs?.settingsVersionId;
  if (typeof id !== "number") return null;
  const version = store.settingsHistory(repoId).find((v) => v.id === id);
  return version === undefined ? null : judgedPins(repoSettingsOf(version).pins);
}

function isJudgedPin(value: unknown): value is JudgedPin {
  const pin = value as Partial<JudgedPin> | null;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
  return typeof pin === "object" && pin !== null && typeof pin.topic === "string" && strings(pin.paths) && strings(pin.keywords);
}

/** The repo's pins now, VISION.md's first, read afresh from its latest settings version, which pins take effect from at once (spec §15). */
export function currentPins(store: Store, repoId: number): { pins: JudgedPin[]; settingsVersionId: number | null } {
  const current = readRepoSettings(store, repoId);
  return { pins: judgedPins(current?.settings.pins ?? []), settingsVersionId: current?.version.id ?? null };
}

/** Whether two lists of pins hold the same pins, compared whole. */
export function samePins(a: readonly JudgedPin[], b: readonly JudgedPin[]): boolean {
  const change = pinChange(a, b);
  return change.removed.length === 0 && change.added.length === 0;
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

/** What changed in the vision since a judgment: none when no vision change was recorded since. */
interface VisionSince {
  /** The vision the judgment read, and the vision of record now; the same commit when nothing changed. */
  fromSha: string;
  toSha: string;
  /** Every vision change since, oldest first. */
  changes: VisionChangeRecord[];
  /** The lines removed and added across all of them, net, at those two visions. */
  removed: VisionLine[];
  added: VisionLine[];
}

/** What changed in the pins since a judgment, and the pins now. */
interface PinsSince {
  /** The repo's pins now, VISION.md's first, which a re-check judges against. */
  pins: JudgedPin[];
  /** The settings version they come from; null when the repo has none recorded. */
  settingsVersionId: number | null;
  /** The pins removed and added since, net, compared whole; none when the judgment recorded no pins. */
  pinsRemoved: JudgedPin[];
  pinsAdded: JudgedPin[];
}

/** A ticket flagged by vision changes, pin changes or both, with what it is re-checked on. */
export interface VisionFlag extends VisionSince, PinsSince {
  ticketId: number;
  /** The judgment the flag is against, which the re-check is given as the prior call. */
  judgmentCallId: number;
  /** The repo's latest vision change recorded when the flag was worked out, so one recorded since restarts the re-check. */
  latestVisionChangeId: number | null;
}

/** An open board item touched by vision changes or pin changes since it was raised. */
export interface TouchedItem extends VisionSince, PinsSince {
  ticketId: number;
  boardItemId: number;
  /** Whether a vision change touched it; otherwise only a pin change did. */
  byVision: boolean;
  /** The pins whose change touched it, by topic: every pin added, and each removed pin it names. */
  pinsTouching: string[];
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
    const latestVisionChangeId = this.#store.visionChanges(repo.id).at(-1)?.id ?? null;
    const since = await this.#since(repo, basis.visionSha, basis.judgment.madeAt);
    const pins = this.#pinsSince(repo, pinsJudgedBy(this.#store, repo.id, basis.judgment));
    const byVision = since !== null && visionChangeFlags(basis, lineTexts(since));
    if (!byVision && !pinChangeFlags(basis, { removed: pins.pinsRemoved, added: pins.pinsAdded })) return null;
    return { ticketId: ticket.id, judgmentCallId: basis.judgment.id, latestVisionChangeId, ...(since ?? unchanged(basis.visionSha)), ...pins };
  }

  /** The ticket's open board item, when a vision change or pin change since it was raised touches it, or null. */
  async touchedOf(repo: RepoRecord, ticket: TicketRecord): Promise<TouchedItem | null> {
    if (ticket.state !== "on-the-board") return null;
    const item = this.#store.openBoardItem(ticket.id);
    if (item === null) return null;
    const snapshot = item.snapshot as Partial<BoardItemSnapshot> | null;
    const check = snapshot?.visionCheck;
    const commit = check !== undefined && typeof check.commit === "string" ? check.commit : null;
    const since = commit === null ? null : await this.#since(repo, commit, item.raisedAt);
    const checked = check === undefined ? [] : [...check.lines.map((line) => line.text), ...check.unquotable.map((line) => line.line)];
    const byVision = since !== null && visionChangeTouchesItem(checked, lineTexts(since));
    const pins = this.#pinsSince(repo, this.#pinsRaisedOn(repo, item, snapshot));
    const named = pinsNamedBy(snapshot);
    const byPins = pinChangeTouchesItem(named, { removed: pins.pinsRemoved, added: pins.pinsAdded });
    if (!byVision && !byPins) return null;
    const removedNamed = pins.pinsRemoved.filter((pin) => named.includes(collapseWhitespace(pin.topic)));
    const pinsTouching = byPins ? [...pins.pinsAdded, ...removedNamed].map((pin) => pin.topic) : [];
    const vision = since ?? unchanged(commit ?? "");
    return { ticketId: ticket.id, boardItemId: item.id, ...vision, ...pins, byVision, pinsTouching };
  }

  /**
   * The pins an open board item was raised on: for a landing pin item, the
   * pins of the landing check that raised it, which used the pins current at
   * check time; otherwise the pins the call that raised it judged.
   */
  #pinsRaisedOn(repo: RepoRecord, item: BoardItemRecord, snapshot: Partial<BoardItemSnapshot> | null): JudgedPin[] | null {
    const callId = snapshot?.landing?.landingCallId ?? item.callId;
    const call = this.#store.getCall(callId);
    return call === null ? null : pinsJudgedBy(this.#store, repo.id, call);
  }

  /** The repo's pins now, and the pins removed and added since the pins judged; none when those are not known. */
  #pinsSince(repo: RepoRecord, judged: JudgedPin[] | null): PinsSince {
    const now = currentPins(this.#store, repo.id);
    const change = judged === null ? { removed: [], added: [] } : pinChange(judged, now.pins);
    return { pins: now.pins, settingsVersionId: now.settingsVersionId, pinsRemoved: [...change.removed], pinsAdded: [...change.added] };
  }

  /**
   * The vision changes recorded after the vision at `fromSha`, and the lines
   * they removed and added, net; null when there are none. The changes are
   * found by VISION.md's blob at `fromSha`; when no recorded change or the
   * enrollment has that blob, by the time the judgment was made.
   */
  async #since(repo: RepoRecord, fromSha: string, madeAt: string): Promise<VisionSince | null> {
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

/** No vision change since a judgment at `sha`: the vision of record is the one it read. */
function unchanged(sha: string): VisionSince {
  return { fromSha: sha, toSha: sha, changes: [], removed: [], added: [] };
}

function lineTexts(change: { removed: readonly VisionLine[]; added: readonly VisionLine[] }): LinesChanged {
  return { removed: change.removed.map((line) => line.text), added: change.added.map((line) => line.text) };
}
