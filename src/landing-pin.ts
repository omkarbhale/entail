import { posix } from "node:path";
import { pinsSeen } from "./after-answer.ts";
import {
  raiseToBoard,
  type BoardItemSnapshot,
  type BoardMirror,
  type BoardOption,
  type BoardOptions,
  type LandingPinItem,
  type PinnedPathTouched,
  type RaiseRequest,
  type TouchedPin,
} from "./board-item.ts";
import type { CriteriaDetail } from "./criteria.ts";
import { judgedPins, type RecordedVerdict } from "./decider.ts";
import { CLEARED_LABEL, RAISED_LABEL } from "./intake-comment.ts";
import type { PassingLandingDetail } from "./merge.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import type { PullRequest } from "./forge/forge.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import { readRepoSettings, type Pin } from "./repo-settings.ts";
import type { AnswerRecord, BoardItemRecord, CallRecord, RepoRecord, Store, TicketRecord } from "./store.ts";
import { withdrawOpenItem } from "./withdraw.ts";

/**
 * A pinned path touched at landing (spec §11, ADR-0014, ADR-0008).
 *
 * - An unopposed ticket's criteria already fence every pin's paths and
 *   VISION.md, so its PR fails such a change mechanically. For any other
 *   cleared ticket, a diff that touches a pinned path goes to the owner,
 *   unless the owner's answer on this ticket already covered that pin. The
 *   pins are the repo's as they are at check time, VISION.md's included.
 * - The board item is raised only after everything else in the landing check
 *   passed, the merge guard included, so the owner is never asked about a PR
 *   that would fail anyway. The PR stays open and unmerged, and the ticket
 *   goes on the board, its issue losing `entail:cleared` while it is there.
 * - The item names the pinned paths and takes one of three answers: "Merge
 *   this PR as it is" (entail verifies the same head again and merges, in
 *   `merge.ts`), the owner's own words (a new criteria version written from
 *   them, after which the ticket is cleared again and the PR checked again),
 *   or "Don't go ahead" (the ticket is cancelled and the issue closed).
 * - A new push to the PR withdraws the item, and the landing check runs again;
 *   following the ticket's PRs (`pull-requests.ts`) notices it.
 */

/** The option a landing pin item offers besides the owner's own words and "don't go ahead". */
export const MERGE_AS_IS = "merge";

/** "Merge this PR as it is", as the board form offers it. */
export function mergeAsIsOption(): BoardOption {
  return {
    id: MERGE_AS_IS,
    title: "Merge this PR as it is",
    reading: "Merge this PR as it is",
    outcome: "entail verifies the same head again and merges it.",
    againstVisionLine: false,
  };
}

/** Whether an answer to an item is "Merge this PR as it is" on a landing pin item. */
export function isLandingMergeAnswer(answer: Pick<AnswerRecord, "shape" | "optionId">, snapshot: Partial<BoardItemSnapshot> | null | undefined): boolean {
  return snapshot?.landing !== undefined && answer.shape === "option" && answer.optionId === MERGE_AS_IS;
}

/** Every changed path a pin's path glob matches, with the pin and the glob, in the pins' order. */
export function pinnedPathsTouched(pins: readonly Pin[], changedPaths: readonly string[]): PinnedPathTouched[] {
  const touched: PinnedPathTouched[] = [];
  for (const pin of pins) {
    for (const raw of pin.paths) {
      const glob = raw.trim();
      if (glob === "") continue;
      for (const path of changedPaths) {
        if (posix.matchesGlob(path, glob) && !touched.some((t) => t.pin === pin.topic && t.path === path)) touched.push({ pin: pin.topic, glob, path });
      }
    }
  }
  return touched;
}

/**
 * Whether the criteria in force fence the ticket off every pinned path: they
 * were written for an unopposed verdict, with no answer of the owner's, so a
 * PR touching a pinned path already fails their leaves-path checks.
 */
export function fencedOffPins(criteria: Pick<CriteriaDetail, "verdict" | "goAheadCallId">): boolean {
  return criteria.verdict === "unopposed" && (criteria.goAheadCallId ?? null) === null;
}

/**
 * The pinned paths a passing PR touches that raise its ticket to the owner:
 * none when the criteria fence it off the pins; otherwise each touched path of
 * a pin the owner has not seen for this ticket (ADR-0008).
 *
 * @param pins the repo's pins at check time, VISION.md's first.
 * @param seen the pins the owner has seen for the ticket, by topic.
 */
export function pinnedPathsToRaise(input: {
  criteria: Pick<CriteriaDetail, "verdict" | "goAheadCallId">;
  pins: readonly Pin[];
  seen: readonly string[];
  changedPaths: readonly string[];
}): PinnedPathTouched[] {
  if (fencedOffPins(input.criteria)) return [];
  const seen = new Set(input.seen.map((pin) => pin.trim()));
  return pinnedPathsTouched(input.pins, input.changedPaths).filter((touched) => !seen.has(touched.pin.trim()));
}

/** The pinned paths a passing PR of a ticket touches that raise it, using the repo's pins as they are now. */
export function pinnedPathsAtLanding(store: Store, ticket: TicketRecord, criteria: CriteriaDetail, changedPaths: readonly string[]): PinnedPathTouched[] {
  const pins = judgedPins(readRepoSettings(store, ticket.repoId)?.settings.pins ?? []);
  return pinnedPathsToRaise({ criteria, pins, seen: pinsSeen(store, ticket.id), changedPaths });
}

/** The pins an answered going-ahead landing pin item on any of the tickets listed for this PR at this head, by topic. */
export function pinsCoveredAtHead(store: Store, ticketIds: readonly number[], pullRequest: number, headSha: string): Set<string> {
  const covered = new Set<string>();
  for (const id of ticketIds) {
    for (const { item, answer } of store.boardItemsForTicket(id)) {
      const landing = (item.snapshot as Partial<BoardItemSnapshot> | null)?.landing;
      if (answer === null || answer.shape === "dont-go-ahead" || landing === undefined) continue;
      if (landing.pullRequest !== pullRequest || landing.headSha !== headSha) continue;
      for (const path of landing.paths) covered.add(path.pin.trim());
    }
  }
  return covered;
}

/** The touched pins, by name, each with the paths that touch it. */
export function touchedPinsOf(pullRequest: number, paths: readonly PinnedPathTouched[]): TouchedPin[] {
  const byPin = new Map<string, string[]>();
  for (const p of paths) {
    const whys = byPin.get(p.pin) ?? [];
    whys.push(`PR #${pullRequest} changes \`${p.path}\`, which its path \`${p.glob}\` matches`);
    byPin.set(p.pin, whys);
  }
  return [...byPin].map(([pin, whys]) => ({ pin, why: whys.join("; ") }));
}

/** The pinned paths as the landing comment lists them. */
function pathList(paths: readonly PinnedPathTouched[]): string {
  return paths.map((p) => `- \`${p.path}\`: the pin “${p.pin.trim()}”, by its path \`${p.glob}\``).join("\n");
}

/** The closing of a landing comment whose PR passed but touches a pinned path the owner has not seen (spec §11). */
export function ownerClosing(wording: { pullRequest: string }, headSha: string, paths: readonly PinnedPathTouched[]): string {
  const pr = wording.pullRequest;
  return [
    `This ${pr} changes pinned paths, and a touched pin always comes to the owner:`,
    pathList(paths),
    `entail raised it to the owner and does not merge it at \`${headSha}\` until the owner decides. A new push gets it checked again.`,
  ].join("\n\n");
}

/** The latest landing call of a ticket whose run raised it for a touched pin, with no raise recorded after it. Null when none is owed. */
export function owedLandingPinRaise(ticket: TicketRecord, calls: readonly CallRecord[]): CallRecord | null {
  if (ticket.state !== "landing") return null;
  const latest = calls.findLast((call) => call.kind === "landing");
  if (latest === undefined || latest.id <= (ticket.stateCallId ?? 0)) return null;
  if ((latest.detail as Partial<PassingLandingDetail> | null)?.merge?.decision !== "owner") return null;
  if (calls.some((call) => call.id > latest.id && call.kind === "raise")) return null;
  return latest;
}

/**
 * The raise a landing call that found a touched pin asks for: the vision
 * check of the verdict the criteria were written for, the PR and the pinned
 * paths, and the option "Merge this PR as it is".
 */
export function landingPinRaise(ticket: TicketRecord, landing: CallRecord, calls: readonly CallRecord[]): RaiseRequest {
  const detail = landing.detail as PassingLandingDetail;
  const merge = detail.merge;
  if (merge.decision !== "owner") throw new Error(`landing call ${landing.id} did not raise its ticket to the owner`);
  const criteriaCall = calls.findLast(
    (call) => call.kind === "criteria" && (call.detail as Partial<CriteriaDetail> | null)?.version === detail.criteriaVersion,
  );
  const verdictCallId = (criteriaCall?.detail as Partial<CriteriaDetail> | null)?.verdictCallId;
  const verdict = calls.find((call) => call.id === verdictCallId && call.kind === "verdict")?.detail as RecordedVerdict | undefined;
  const item: LandingPinItem = { pullRequest: detail.pullRequest, url: detail.url, headSha: detail.headSha, landingCallId: landing.id, paths: merge.paths };
  return {
    ticket,
    why: { kind: "landing_pin", pullRequest: detail.pullRequest, paths: merge.paths, pins: touchedPinsOf(detail.pullRequest, merge.paths) },
    visionCommit: verdict?.vision_sha ?? detail.baseSha,
    marked: verdict?.vision_check ?? [],
    readings: [],
    openReadings: [],
    inputs: criteriaCall?.inputs ?? null,
    basedOnCallId: landing.id,
    options: [mergeAsIsOption()],
    landing: item,
    removeLabel: CLEARED_LABEL,
  };
}

/** The ticket's open board item when it is a landing pin item. */
export function openLandingItem(store: Store, ticket: TicketRecord): { item: BoardItemRecord; landing: LandingPinItem } | null {
  if (ticket.state !== "on-the-board") return null;
  const item = store.openBoardItem(ticket.id);
  const landing = (item?.snapshot as Partial<BoardItemSnapshot> | null | undefined)?.landing;
  return item === null || landing === undefined ? null : { item, landing };
}

/** Raising a ticket at landing for a touched pin. */
export interface LandingPinRaising {
  /** Raises a landing ticket whose passing run found a touched pin; owed until its raise is recorded. */
  raise(ticket: TicketRecord, landing: CallRecord, pass: RepoPass): Promise<void>;
  /** The raise a landing ticket owes, as when it was not raised in the run that found the pin. */
  planner: OwedStepPlanner;
}

export function landingPinRaising(options: BoardOptions): LandingPinRaising {
  const { store } = options;
  const mirrors = new Map<number, Promise<BoardMirror>>();
  const mirrorFor =
    options.mirrorFor ??
    ((repo: RepoRecord) =>
      Mirror.open({
        dataDirectory: options.dataDirectory,
        key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
        remote: forgeRemote(repo.forge, repo.host, repo.path),
        log: options.log,
      }));
  const mirror = (repo: RepoRecord): Promise<BoardMirror> => {
    let found = mirrors.get(repo.id);
    if (!found) {
      found = mirrorFor(repo);
      found.catch(() => mirrors.delete(repo.id));
      mirrors.set(repo.id, found);
    }
    return found;
  };

  const raise = async (ticket: TicketRecord, landing: CallRecord, pass: RepoPass): Promise<void> => {
    const calls = store.callsForTicket(ticket.id);
    if (owedLandingPinRaise(ticket, calls)?.id !== landing.id) return;
    await raiseToBoard(options, landingPinRaise(ticket, landing, calls), pass, await mirror(pass.repo));
  };

  const planner: OwedStepPlanner = (ticket, pass): OwedStep | null => {
    const owed = owedLandingPinRaise(ticket, store.callsForTicket(ticket.id));
    return owed === null ? null : { name: "raise", run: () => raise(ticket, owed, pass) };
  };

  return { raise, planner };
}

/**
 * Withdraws an open landing pin item when its PR, as following the ticket's
 * PRs read it, has a new head (spec §13, ADR-0014): in one transaction, a call
 * that takes the ticket back to landing, where the landing check runs again on
 * the new head, with the withdrawal and the intents to take `entail:raised`
 * off the issue and put `entail:cleared` back; then it sends the labels. A PR still at the item's head,
 * or no longer open, withdraws nothing.
 */
export async function withdrawOnNewPush(
  options: { store: Store; log: OperationalLog },
  ticket: TicketRecord,
  open: { item: BoardItemRecord; landing: LandingPinItem },
  pr: Pick<PullRequest, "number" | "state" | "headSha">,
  pass: RepoPass,
): Promise<void> {
  const { store, log } = options;
  if (pr.number !== open.landing.pullRequest || pr.state !== "open" || pr.headSha === open.landing.headSha) return;
  const recorded = store.transaction(() => {
    const now = store.getTicket(ticket.id);
    if (now === null || now.state !== ticket.state || now.stateCallId !== ticket.stateCallId) return null;
    if (store.openBoardItem(ticket.id)?.id !== open.item.id) return null;
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "new-push",
      reason: `PR #${pr.number} moved from ${open.landing.headSha.slice(0, 12)} to ${pr.headSha.slice(0, 12)} while its pinned paths were on the board, so the item is withdrawn and the landing check runs again on the new head.`,
      inputs: { prHeadSha: pr.headSha, settingsVersionId: pass.settings.id },
      detail: { pullRequests: [pr.number], boardItemId: open.item.id, fromHeadSha: open.landing.headSha, toHeadSha: pr.headSha },
      stateTo: "landing",
    });
    withdrawOpenItem(store, { ticketId: ticket.id, callId: call.id, basis: { kind: "new-push" } });
    const write = { repoId: pass.repo.id, ticketId: ticket.id, callId: call.id, kind: "label", target: "issue", number: ticket.issueNumber } as const;
    store.recordForgeWriteIntent({ ...write, payload: { action: "remove", label: RAISED_LABEL } });
    store.recordForgeWriteIntent({ ...write, payload: { action: "add", label: CLEARED_LABEL } });
    return call;
  });
  if (recorded === null) return;
  log.info("landing-pin-withdrawn", { ticketId: ticket.id, callId: recorded.id, boardItemId: open.item.id, pullRequest: pr.number, headSha: pr.headSha });
  // Each resumes the intent recorded above.
  await pass.writer().removeLabel({ ticketId: ticket.id, callId: recorded.id }, ticket.issueNumber, RAISED_LABEL);
  await pass.writer().addLabel({ ticketId: ticket.id, callId: recorded.id }, ticket.issueNumber, CLEARED_LABEL);
}
