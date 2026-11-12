import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { api, ApiError, failureText, type ActionView, type CallView, type HeldView, type OwnerCallName } from "../api.ts";
import { answerChoices, issueKey, overrideChoices, receiptText, refNumber, subject } from "../format.ts";
import { dropHeldFromCache, holdInCache, WAITING } from "../queries.ts";
import { useDraft, useToast } from "../state.tsx";
import { Chip, Spinner } from "./Verdict.tsx";

/** The owner's three answers to a call, each recorded at once and held for ten seconds before entail acts on GitHub. */

export type OwnerRequest =
  | { kind: "confirm" }
  | { kind: "override"; to: OwnerCallName; reason: string; differently: boolean }
  | { kind: "answer"; to: OwnerCallName; answer: string };

export function useAct(item: CallView, onRecorded?: (action: ActionView) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: OwnerRequest): Promise<ActionView> => {
      if (request.kind === "confirm") return api.confirm(item.id);
      if (request.kind === "override") return api.override(item.id, request.to, request.reason, request.differently);
      return api.answer(item.id, request.to, request.answer);
    },
    onSuccess: (action) => {
      if (action.holdUntil !== undefined) client.setQueryData(WAITING, (data: Parameters<typeof holdInCache>[0]) => holdInCache(data, { item, action, holdUntil: action.holdUntil! }));
      onRecorded?.(action);
      void client.invalidateQueries();
    },
  });
}

const VERBS: Record<OwnerRequest["kind"], string> = { confirm: "Confirming…", override: "Recording your override…", answer: "Recording your answer…" };

export function pendingVerb(kind: OwnerRequest["kind"]): string {
  return VERBS[kind];
}

export function ErrorNote({ error, onDismiss }: { error: unknown; onDismiss: () => void }) {
  return (
    <div className="err" role="alert">
      {failureText(error)}{" "}
      <button type="button" className="link" onClick={onDismiss}>
        OK
      </button>
    </div>
  );
}

/** The override line: the owner's call (the opposite one preselected) and a one-line reason, which is required. */
export function OverrideForm({ item, act, onCancel }: { item: CallView; act: ReturnType<typeof useAct>; onCancel: () => void }) {
  const choices = overrideChoices(item);
  const key = issueKey(item);
  const [pick, setPick] = useDraft(`ov-pick:${key}`);
  const [reason, setReason] = useDraft(`ov:${key}`);
  const [missing, setMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choice = choices.find((candidate) => candidate.key === pick) ?? choices[0]!;
  const pending = act.isPending;
  useEffect(() => input.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() === "") {
      setMissing(true);
      input.current?.focus();
      return;
    }
    act.mutate({ kind: "override", to: choice.to, reason: reason.trim(), differently: choice.differently });
  };
  return (
    <form className="ov" onSubmit={submit} onKeyDown={(event) => event.key === "Escape" && !pending && onCancel()}>
      <div className="choices" role="radiogroup" aria-label="Your call">
        {choices.length > 1 ? (
          choices.map((candidate) => (
            <label className="pill" key={candidate.key}>
              <input type="radio" name={`ov-${item.id}`} value={candidate.key} checked={candidate.key === choice.key} onChange={() => setPick(candidate.key)} disabled={pending} />
              {candidate.label}
            </label>
          ))
        ) : (
          <span className="pill static">
            <Chip call={choice.to} /> {choice.label}
          </span>
        )}
      </div>
      <input
        ref={input}
        className="field"
        aria-label={choice.differently ? "What should be different" : "Your reason"}
        placeholder={choice.placeholder}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          if (missing) setMissing(false);
        }}
        disabled={pending}
        autoComplete="off"
      />
      <div className="ov-row">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? (
            <>
              <Spinner />
              {pendingVerb("override")}
            </>
          ) : (
            "Override"
          )}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <span className="hint">Enter sends · Esc cancels · a reason is required</span>
      </div>
      {missing && (
        <div className="err" role="alert">
          Say why in a line: it goes on the {subject(item)} and into the case book.
        </div>
      )}
      {act.isError && <ErrorNote error={act.error} onDismiss={() => act.reset()} />}
    </form>
  );
}

/** The answer to a question: go or don't, one click, with an optional note in the owner's words. */
export function AnswerForm({ item, act, inputRef }: { item: CallView; act: ReturnType<typeof useAct>; inputRef?: RefObject<HTMLInputElement | null> }) {
  const key = issueKey(item);
  const [pick, setPick] = useDraft(`ans-pick:${key}`);
  const [note, setNote] = useDraft(`ans:${key}`);
  const choices = answerChoices(item);
  const choice = choices.find((candidate) => candidate.to === pick);
  const pending = act.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (choice === undefined) return;
    act.mutate({ kind: "answer", to: choice.to, answer: note.trim() === "" ? `${choice.label}.` : note.trim() });
  };
  return (
    <form onSubmit={submit}>
      <div className="readings" role="radiogroup" aria-label="Your answer">
        {choices.map((candidate) => (
          <label className="reading" key={candidate.to}>
            <input type="radio" name={`ans-${item.id}`} value={candidate.to} checked={pick === candidate.to} onChange={() => setPick(candidate.to)} disabled={pending} />
            <span>
              <b>{candidate.label}</b>
              {candidate.lean && <span className="lean">entail leans here</span>}
              <span className="rnote">{candidate.note}</span>
            </span>
          </label>
        ))}
      </div>
      <input
        ref={inputRef}
        className="field"
        aria-label="Your answer in your own words"
        placeholder={choice === undefined ? "Pick one above, and add your own words if you like" : "Add a note in your own words (optional)"}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        disabled={pending}
        autoComplete="off"
      />
      <div className="actions">
        <button className="btn primary" type="submit" disabled={pending || choice === undefined}>
          {pending ? (
            <>
              <Spinner />
              {pendingVerb("answer")}
            </>
          ) : (
            "Answer"
          )}
        </button>
        <span className="muted small">Recorded under your name, {item.pr === null ? "posted on the issue" : "acted on the PR"}, added to the case book.</span>
        <span className="keys">
          <kbd>a</kbd> answer
        </span>
      </div>
      {act.isError && <ErrorNote error={act.error} onDismiss={() => act.reset()} />}
    </form>
  );
}

/**
 * The receipt an item becomes once the owner has acted: what they did, what
 * entail does when the window closes, and Undo with the seconds left.
 */
export function Receipt({ held, onUndone, onGone }: { held: HeldView; onUndone?: (action: ActionView) => void; onGone?: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const until = Date.parse(held.holdUntil);
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  const [leaving, setLeaving] = useState(false);
  const undo = useMutation({
    mutationFn: () => api.undo(held.item.id),
    onSuccess: () => {
      client.setQueryData(WAITING, (data: Parameters<typeof dropHeldFromCache>[0]) => dropHeldFromCache(data, held.item.id));
      toast("Undone. Nothing was sent to GitHub.");
      onUndone?.(held.action);
      void client.invalidateQueries();
    },
  });
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 250);
    return () => window.clearInterval(timer);
  }, [until]);
  useEffect(() => {
    if (left > 0 || undo.isPending || undo.isSuccess) return;
    setLeaving(true);
    const timer = window.setTimeout(() => {
      client.setQueryData(WAITING, (data: Parameters<typeof dropHeldFromCache>[0]) => dropHeldFromCache(data, held.item.id));
      onGone?.();
      void client.invalidateQueries();
    }, 380);
    return () => window.clearTimeout(timer);
  }, [left, undo.isPending, undo.isSuccess, client, held.item.id, onGone]);
  const text = receiptText(held.item, held.action);
  return (
    <article className={`item receipt${leaving ? " leaving" : ""}`} data-key={issueKey(held.item)} aria-label={`${text.head} #${refNumber(held.item)}`}>
      <span className="tick" aria-hidden="true">
        ✓
      </span>
      <div className="rt">
        <b>{text.head}</b> {text.call !== null && held.action.type !== "confirmed" && <Chip call={text.call} />} {text.text}
        {text.quote !== null && (
          <>
            {" "}
            <q>{text.quote}</q>
          </>
        )}
        {undo.isError && (
          <div className="err" role="alert">
            {undo.error instanceof ApiError && !undo.error.network ? `Not undone: ${undo.error.message}.` : "entail did not answer, so it was not undone. Try again."}
          </div>
        )}
      </div>
      {left > 0 && !leaving && (
        <button type="button" className="btn ghost sm" onClick={() => undo.mutate()} disabled={undo.isPending}>
          {undo.isPending ? (
            <>
              <Spinner />
              Undoing…
            </>
          ) : (
            <>
              Undo <span className="cd">{left}s</span>
            </>
          )}
        </button>
      )}
    </article>
  );
}
