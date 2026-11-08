import { assertCommentRules, markedTickets } from "./comment-rules.ts";
import {
  assertEntailLabel,
  type CloseReason,
  type Forge,
  type ForgeTarget,
  type MergeMethod,
  type MergeOutcome,
  type PostedComment,
} from "./forge/forge.ts";
import type { ForgeWriteIntentRecord, ForgeWriteKind, RepoRecord, Store } from "./store.ts";

/**
 * What each kind of forge write records as its intent's payload: everything
 * needed to send it again, or to recognise it on the forge, after a restart.
 */
export interface CommentPayload {
  body: string;
}
export interface LabelPayload {
  action: "add" | "remove";
  label: string;
}
export interface ClosePayload {
  reason: CloseReason;
}
export interface MergePayload {
  sha: string;
  method: MergeMethod | null;
}

/** The ticket a write is for, and the call it carries out when there is one. */
export interface WriteFor {
  ticketId: number;
  callId?: number | null;
}

/**
 * The one way entail writes to a forge (ADR-0015, ADR-0017). Each of the four
 * writes is recorded in the store as an intent before it is sent and confirmed
 * after, so a crash in between is settled on the next start by reading the
 * forge instead of guessing. Comments must follow the comment rules, or
 * nothing is recorded or sent.
 *
 * A write that throws stays unconfirmed. Asking for the same write again
 * resumes its intent rather than recording a second one, settling it first
 * where the forge can say whether it already happened, so a retry never
 * duplicates a comment or a merge.
 */
export class ForgeWriter {
  readonly #store: Store;
  readonly #forge: Forge;
  readonly #repo: RepoRecord;
  readonly #ownerName: string;
  readonly #inFlight: InFlightWrites | undefined;

  /**
   * @param ownerName The owner's display name from settings, which the
   *   attribution line carries.
   * @param inFlight Where each write is counted while it is in flight, so
   *   stopping can wait for it to confirm.
   */
  constructor(store: Store, forge: Forge, repo: RepoRecord, ownerName: string, inFlight?: InFlightWrites) {
    this.#store = store;
    this.#forge = forge;
    this.#repo = repo;
    this.#ownerName = ownerName;
    this.#inFlight = inFlight;
  }

  /**
   * Posts `body` on an issue or PR for a ticket.
   *
   * @throws {CommentRuleError} when the body lacks the attribution line or the
   *   ticket's hidden marker, or has a line starting with `/`.
   */
  comment(write: WriteFor, target: ForgeTarget, number: number, body: string): Promise<PostedComment> {
    return this.#track(this.#comment(write, target, number, body));
  }

  async #comment(write: WriteFor, target: ForgeTarget, number: number, body: string): Promise<PostedComment> {
    assertCommentRules(body, this.#ownerName, write.ticketId);
    const payload: CommentPayload = { body };
    const { intent, resumed } = this.#intend(write, "comment", target, number, payload);
    if (resumed) {
      const found = findPostedComment(await this.#forge.comments(target, number), this.#store, this.#repo, intent);
      if (found) {
        this.#confirmComment(intent, found, "found by its hidden marker");
        return found;
      }
    }
    const posted = await this.#forge.postComment(target, number, body);
    this.#confirmComment(intent, posted, null);
    return posted;
  }

  /** Adds an `entail:` label to an issue, creating the label on first use. */
  addLabel(write: WriteFor, issueNumber: number, label: string): Promise<void> {
    return this.#track(this.#label(write, issueNumber, { action: "add", label }));
  }

  /** Removes an `entail:` label from an issue. */
  removeLabel(write: WriteFor, issueNumber: number, label: string): Promise<void> {
    return this.#track(this.#label(write, issueNumber, { action: "remove", label }));
  }

  /** Closes an issue, as not planned on GitHub when `reason` says so. */
  closeIssue(write: WriteFor, issueNumber: number, reason: CloseReason): Promise<void> {
    return this.#track(this.#closeIssue(write, issueNumber, reason));
  }

  async #closeIssue(write: WriteFor, issueNumber: number, reason: CloseReason): Promise<void> {
    const payload: ClosePayload = { reason };
    const { intent } = this.#intend(write, "close", "issue", issueNumber, payload);
    await applyAgain(this.#forge, intent);
    this.#store.confirmForgeWrite({ intentId: intent.id, result: { outcome: "closed" } });
  }

  /**
   * Merges a PR pinned to `sha`. Anything other than merged comes back as a
   * refusal, recorded with the intent's confirmation.
   */
  merge(write: WriteFor, prNumber: number, sha: string, method?: MergeMethod): Promise<MergeOutcome> {
    return this.#track(this.#merge(write, prNumber, sha, method));
  }

  async #merge(write: WriteFor, prNumber: number, sha: string, method?: MergeMethod): Promise<MergeOutcome> {
    const payload: MergePayload = { sha, method: method ?? null };
    const { intent, resumed } = this.#intend(write, "merge", "pr", prNumber, payload);
    if (resumed) {
      const state = await this.#forge.pullRequestState(prNumber);
      if (state.state === "merged") {
        this.#store.confirmForgeWrite({
          intentId: intent.id,
          result: { outcome: "merged", mergeCommitSha: state.mergeCommitSha, settled: "read the PR's state" },
        });
        return { merged: true, mergeCommitSha: state.mergeCommitSha };
      }
    }
    const outcome = await this.#forge.merge(prNumber, sha, method);
    this.#store.confirmForgeWrite({
      intentId: intent.id,
      result: outcome.merged
        ? { outcome: "merged", mergeCommitSha: outcome.mergeCommitSha }
        : { outcome: "refused", refusal: outcome.refusal },
    });
    return outcome;
  }

  #track<T>(write: Promise<T>): Promise<T> {
    return this.#inFlight ? this.#inFlight.track(write) : write;
  }

  async #label(write: WriteFor, issueNumber: number, payload: LabelPayload): Promise<void> {
    assertEntailLabel(payload.label);
    const { intent } = this.#intend(write, "label", "issue", issueNumber, payload);
    await applyAgain(this.#forge, intent);
    this.#store.confirmForgeWrite({ intentId: intent.id, result: { outcome: payload.action === "add" ? "added" : "removed" } });
  }

  /**
   * The intent for a write: an unconfirmed one for exactly the same write,
   * resumed, or a new one. A new label, close or merge supersedes any older
   * unconfirmed one for the same label, issue or PR, so settling on start
   * never applies a stale write over a newer one.
   */
  #intend(
    write: WriteFor,
    kind: ForgeWriteKind,
    target: ForgeTarget,
    number: number,
    payload: CommentPayload | LabelPayload | ClosePayload | MergePayload,
  ): { intent: ForgeWriteIntentRecord; resumed: boolean } {
    return this.#store.transaction(() => {
      const pending = this.#store
        .unconfirmedForgeWrites()
        .filter((i) => i.repoId === this.#repo.id && i.kind === kind && i.target === target && i.number === number);
      const same = pending.find((i) => i.ticketId === write.ticketId && JSON.stringify(i.payload) === JSON.stringify(payload));
      if (same) return { intent: same, resumed: true };

      const intent = this.#store.recordForgeWriteIntent({
        repoId: this.#repo.id,
        ticketId: write.ticketId,
        callId: write.callId ?? null,
        kind,
        target,
        number,
        payload,
      });
      if (kind !== "comment") {
        const label = kind === "label" ? (payload as LabelPayload).label : null;
        for (const older of pending) {
          if (label !== null && (older.payload as LabelPayload).label !== label) continue;
          this.#store.confirmForgeWrite({ intentId: older.id, result: { outcome: "superseded", by: intent.id } });
        }
      }
      return { intent, resumed: false };
    });
  }

  #confirmComment(intent: ForgeWriteIntentRecord, comment: PostedComment, settled: string | null): void {
    this.#store.confirmForgeWrite({
      intentId: intent.id,
      comment: { id: String(comment.id), url: comment.url },
      result: settled === null ? { outcome: "posted" } : { outcome: "posted", settled },
    });
  }
}

/**
 * The forge writes in flight across entail. Stopping waits for them to
 * confirm, up to a limit; any left unconfirmed are settled on the next start
 * (ADR-0017).
 */
export class InFlightWrites {
  readonly #pending = new Set<Promise<unknown>>();

  /** How many writes are in flight now. */
  get count(): number {
    return this.#pending.size;
  }

  /** Counts `write` as in flight until it settles, and returns it. */
  track<T>(write: Promise<T>): Promise<T> {
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(settled);
    void settled.then(() => this.#pending.delete(settled));
    return write;
  }

  /**
   * Waits until every write in flight now has settled, or `waitMs` has
   * passed, whichever is first. Resolves to how many are still in flight.
   */
  async settle(waitMs: number): Promise<number> {
    if (this.#pending.size === 0) return 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([Promise.all([...this.#pending]), timeout]);
    clearTimeout(timer);
    return this.#pending.size;
  }
}

/** One unconfirmed write as start-up settled it, or why it could not be. */
export type SettledWrite =
  | { intentId: number; kind: ForgeWriteKind; settled: string }
  | { intentId: number; kind: ForgeWriteKind; error: Error };

/**
 * Settles every unconfirmed forge write, oldest first, by reading the forge
 * (ADR-0017). It runs on start, before the first pass:
 *
 * - a comment is found by its hidden marker and its text, and posted only if
 *   it is not there;
 * - a merge is found by the PR's state; one that did not happen is not sent
 *   again, because the merge guard must pass afresh, and the next pass
 *   re-derives the landing from the records;
 * - labels and closes are applied again, which changes nothing if they had
 *   gone through.
 *
 * A repo whose forge is not given (its host is halted) keeps its intents for a
 * later start. After a write in a repo fails to settle, that repo's later
 * writes wait too, so they are never applied out of order.
 */
export async function settleUnconfirmedWrites(
  store: Store,
  forgeFor: (repo: RepoRecord) => Forge | null,
): Promise<SettledWrite[]> {
  const results: SettledWrite[] = [];
  const stopped = new Set<number>();
  const forges = new Map<number, Forge | null>();
  for (const intent of store.unconfirmedForgeWrites()) {
    if (stopped.has(intent.repoId)) continue;
    if (!forges.has(intent.repoId)) {
      const repo = store.getRepo(intent.repoId);
      forges.set(intent.repoId, repo ? forgeFor(repo) : null);
    }
    const forge = forges.get(intent.repoId);
    if (!forge) {
      stopped.add(intent.repoId);
      continue;
    }
    try {
      const settled = await settleOne(store, forge, intent);
      results.push({ intentId: intent.id, kind: intent.kind, settled });
    } catch (error) {
      stopped.add(intent.repoId);
      results.push({ intentId: intent.id, kind: intent.kind, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return results;
}

async function settleOne(store: Store, forge: Forge, intent: ForgeWriteIntentRecord): Promise<string> {
  switch (intent.kind) {
    case "comment": {
      const repo = store.getRepo(intent.repoId)!;
      const found = findPostedComment(await forge.comments(intent.target, intent.number), store, repo, intent);
      if (found) {
        store.confirmForgeWrite({
          intentId: intent.id,
          comment: { id: String(found.id), url: found.url },
          result: { outcome: "posted", settled: "found by its hidden marker" },
        });
        return "found by its hidden marker";
      }
      const { body } = intent.payload as CommentPayload;
      const posted = await forge.postComment(intent.target, intent.number, body);
      store.confirmForgeWrite({
        intentId: intent.id,
        comment: { id: String(posted.id), url: posted.url },
        result: { outcome: "posted", settled: "not found, so posted" },
      });
      return "not found, so posted";
    }
    case "label":
    case "close": {
      await applyAgain(forge, intent);
      const outcome = intent.kind === "close" ? "closed" : (intent.payload as LabelPayload).action === "add" ? "added" : "removed";
      store.confirmForgeWrite({ intentId: intent.id, result: { outcome, settled: "applied again" } });
      return "applied again";
    }
    case "merge": {
      const state = await forge.pullRequestState(intent.number);
      if (state.state === "merged") {
        store.confirmForgeWrite({
          intentId: intent.id,
          result: { outcome: "merged", mergeCommitSha: state.mergeCommitSha, settled: "read the PR's state" },
        });
        return "merged, by the PR's state";
      }
      store.confirmForgeWrite({
        intentId: intent.id,
        result: { outcome: "not-merged", state: state.state, headSha: state.headSha, settled: "read the PR's state" },
      });
      return `not merged, by the PR's state (${state.state})`;
    }
  }
}

/** Sends a label or close write. Both are safe to send again: a second send changes nothing. */
async function applyAgain(forge: Forge, intent: ForgeWriteIntentRecord): Promise<void> {
  if (intent.kind === "close") {
    await forge.closeIssue(intent.number, (intent.payload as ClosePayload).reason);
    return;
  }
  const { action, label } = intent.payload as LabelPayload;
  if (action === "add") await forge.addLabel(intent.number, label);
  else await forge.removeLabel(intent.number, label);
}

/**
 * entail's own comment for an unconfirmed intent, if the forge has it: posted
 * by the owner's account, carrying the ticket's hidden marker and the intent's
 * exact text, and not already confirmed for another intent.
 */
function findPostedComment(
  comments: readonly { id: number; body: string; url: string; author: { id: number } }[],
  store: Store,
  repo: RepoRecord,
  intent: ForgeWriteIntentRecord,
): PostedComment | null {
  if (intent.ticketId === null) return null;
  const claimed = new Set(store.confirmedCommentIds(repo.id, intent.target, intent.number));
  const body = normalized((intent.payload as CommentPayload).body);
  const found = comments.find(
    (c) =>
      c.author.id === repo.ownerAccountId &&
      !claimed.has(String(c.id)) &&
      markedTickets(c.body).includes(intent.ticketId!) &&
      normalized(c.body) === body,
  );
  return found ? { id: found.id, url: found.url } : null;
}

/** A comment's text as both forges store it: line endings as LF, no surrounding whitespace. */
function normalized(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim();
}
