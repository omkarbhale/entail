import type { ForgeWriter } from "./forge-writer.ts";
import type { OperationalLog } from "./operational-log.ts";
import { LABEL_IN_STATE } from "./pull-requests.ts";
import { readRepoSettings, repoSettingsOf } from "./repo-settings.ts";
import type { ForgeWriteIntentRecord, RepoRecord, SettingsVersionRecord, Store, UnenrollmentRecord } from "./store.ts";
import type { TicketState } from "./ticket-states.ts";
import { withdrawOpenItem } from "./withdraw.ts";

/**
 * The owner's switches for a whole repo (spec §15 "Pause", "Resume",
 * "Unenroll", ADR-0018).
 *
 * - **Pause** is a setting: saving it makes a settings version. The passes
 *   stop polling the repo and start no new step there, so entail stops reading
 *   and writing once the steps already running have finished and their writes
 *   are posted; until then the repo shows as "pausing". Labels and ticket
 *   states are kept, and the repo's board items stay, locked.
 * - **Resume** saves the switch off. Polling restarts from the saved cursors,
 *   so changes made during the pause are handled as if entail had been slow.
 *   The board items stay locked until that catch-up has run.
 * - **Unenroll** is not a setting: it cancels every in-flight ticket with a
 *   logged call, removes their `entail:` labels and withdraws their open board
 *   items, then entail reads and writes nothing more in the repo. It posts no
 *   comment and closes nothing. The records stay, read-only, and enrolling the
 *   repo again takes in only new issues.
 */

/** The reason every ticket cancelled on unenroll records. */
export const UNENROLL_REASON = "Cancelled: repo unenrolled.";

/** What an unenroll-cancel call records as its detail. */
export interface UnenrollCancelDetail {
  unenrollmentId: number;
}

/** Saves the repo's pause switch as a new settings version, or saves nothing when it is already set so. */
export function setPaused(store: Store, repoId: number, paused: boolean, savedBy: string): SettingsVersionRecord | null {
  return store.transaction(() => {
    const current = readRepoSettings(store, repoId);
    if (current === null) throw new Error(`repo ${repoId} has no settings`);
    if (current.settings.paused === paused) return null;
    return store.saveSettings(repoId, { ...current.settings, paused }, savedBy);
  });
}

/**
 * The settings version that last resumed the repo, or null when the repo is
 * paused now or was never resumed: its newest version with the switch off
 * whose previous version had it on.
 */
export function latestResume(store: Store, repoId: number): SettingsVersionRecord | null {
  const history = store.settingsHistory(repoId);
  for (let i = 0; i + 1 < history.length; i++) {
    const at = repoSettingsOf(history[i]!).paused;
    if (at) return null;
    if (repoSettingsOf(history[i + 1]!).paused) return history[i]!;
  }
  return null;
}

/** One ticket cancelled on unenroll. */
export interface UnenrollCancel {
  ticketId: number;
  issueNumber: number;
  callId: number;
  from: TicketState;
  /** The open board item withdrawn with it, if any. */
  withdrawnItemId: number | null;
  /** The `entail:` label to remove from its issue, if its state carried one. */
  label: string | null;
}

export interface Unenrolled {
  unenrollment: UnenrollmentRecord;
  cancelled: UnenrollCancel[];
}

/** A repo that cannot be unenrolled because it is not enrolled now. */
export class NotEnrolledError extends Error {
  constructor(repo: RepoRecord) {
    super(`${repo.path} on ${repo.host} is not enrolled`);
    this.name = "NotEnrolledError";
  }
}

/**
 * Records a repo's unenrollment, in one transaction (ADR-0018):
 *
 * 1. every in-flight ticket is cancelled with a logged call whose reason is
 *    "repo unenrolled";
 * 2. the removal of each such ticket's `entail:` label is recorded as an
 *    intent, so no executor works from criteria nobody will check;
 * 3. the repo's open board items are withdrawn.
 *
 * From then on the passes skip the repo, and the forge writer and settling on
 * start send nothing there but those label removals, which
 * {@link removeUnenrollLabels} sends: no comment, no close, whatever other
 * write was left unconfirmed.
 */
export function recordUnenrollment(store: Store, repo: RepoRecord, unenrolledBy: string): Unenrolled {
  return store.transaction(() => {
    if (!store.isEnrolled(repo.id)) throw new NotEnrolledError(repo);
    const settings = store.latestSettings(repo.id);
    const unenrollment = store.recordUnenrollment({ repoId: repo.id, unenrolledBy });
    const cancelled: UnenrollCancel[] = [];
    for (const ticket of store.ticketsInFlight(repo.id)) {
      const detail: UnenrollCancelDetail = { unenrollmentId: unenrollment.id };
      const call = store.recordCall({
        ticketId: ticket.id,
        kind: "unenroll-cancel",
        reason: UNENROLL_REASON,
        inputs: { settingsVersionId: settings?.id ?? null },
        detail,
        stateTo: "cancelled",
      });
      const withdrawn =
        ticket.state === "on-the-board" ? withdrawOpenItem(store, { ticketId: ticket.id, callId: call.id, basis: { kind: "repo-unenrolled" } }) : null;
      const label = LABEL_IN_STATE[ticket.state] ?? null;
      if (label !== null) {
        store.recordForgeWriteIntent({
          repoId: repo.id,
          ticketId: ticket.id,
          callId: call.id,
          kind: "label",
          target: "issue",
          number: ticket.issueNumber,
          payload: { action: "remove", label },
        });
      }
      cancelled.push({ ticketId: ticket.id, issueNumber: ticket.issueNumber, callId: call.id, from: ticket.state, withdrawnItemId: withdrawn?.id ?? null, label });
    }
    return { unenrollment, cancelled };
  });
}

/** Whether a forge write is a label removal an unenroll recorded: the only write entail sends in an unenrolled repo. */
export function isUnenrollLabel(store: Store, intent: ForgeWriteIntentRecord): boolean {
  return intent.kind === "label" && intent.callId !== null && store.getCall(intent.callId)?.kind === "unenroll-cancel";
}

/** The label removals an unenroll recorded and that have not gone out yet. */
export function pendingUnenrollLabels(store: Store, repoId: number): ForgeWriteIntentRecord[] {
  return store.unconfirmedForgeWrites().filter((intent) => intent.repoId === repoId && isUnenrollLabel(store, intent));
}

/**
 * Sends the label removals the repo's unenroll recorded, one at a time. A
 * removal that fails stays unconfirmed and is applied again when entail next
 * starts. Resolves to how many failed.
 */
export async function removeUnenrollLabels(store: Store, repo: RepoRecord, writer: ForgeWriter, log?: OperationalLog): Promise<number> {
  let failed = 0;
  for (const intent of pendingUnenrollLabels(store, repo.id)) {
    const { label } = intent.payload as { label: string };
    try {
      await writer.removeLabel({ ticketId: intent.ticketId!, callId: intent.callId }, intent.number, label);
    } catch (error) {
      failed++;
      log?.warn("unenroll-label-failed", { repoId: repo.id, issue: intent.number, label, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failed;
}
