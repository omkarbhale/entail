import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallView, HeldView } from "../api.ts";
import { AnswerForm, ErrorNote, OverrideForm, pendingVerb, Receipt, useAct } from "../components/Actions.tsx";
import { Welcome } from "../components/Enroll.tsx";
import { Meta, Request, Spinner, Verdict, External } from "../components/Verdict.tsx";
import { ago, confirmLabel, issueKey, shortName } from "../format.ts";
import { useRepos, useSettings, useStatus, useWaiting } from "../queries.ts";
import { useNow } from "../state.tsx";

/**
 * Waiting: everything waiting on the owner across repos, in one column of
 * open cards, read and acted on in place. Questions first, then calls to
 * confirm, oldest first within each.
 */

type Handlers = { confirm?: () => void; override?: () => void; answer?: () => void };

let actedThisVisit = false;

export function WaitingPage({ repo }: { repo: string | null }) {
  const waiting = useWaiting();
  const repos = useRepos();
  const now = useNow();
  const [focused, setFocused] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState<string | null>(null);
  const handlers = useRef(new Map<string, Handlers>());

  const visible = <T extends { repo: string }>(item: T) => repo === null || item.repo === repo;
  const items = useMemo(() => (waiting.data?.items ?? []).filter(visible), [waiting.data, repo]);
  // A receipt whose window closed a while ago is gone, even if entail was read again a moment too early.
  const held = useMemo(() => (waiting.data?.held ?? []).filter((one) => visible(one.item) && Date.parse(one.holdUntil) > now - 2_000), [waiting.data, repo, now]);
  const questions = order(items.filter((item) => item.call === "ask"), held.filter((one) => one.item.call === "ask"));
  const confirms = order(items.filter((item) => item.call !== "ask"), held.filter((one) => one.item.call !== "ask"));
  const actionable = [...questions, ...confirms].filter((entry): entry is CallView => !("holdUntil" in entry)).map(issueKey);

  const register = useCallback((key: string, value: Handlers | null) => {
    if (value === null) handlers.current.delete(key);
    else handlers.current.set(key, value);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select") || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        setOverrideOpen(null);
        return;
      }
      if (actionable.length === 0) return;
      const index = focused === null ? -1 : actionable.indexOf(focused);
      if (event.key === "j" || event.key === "k") {
        const next = event.key === "j" ? Math.min(actionable.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
        const key = actionable[next]!;
        setFocused(key);
        document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (index < 0) return;
      const card = handlers.current.get(actionable[index]!);
      const run = event.key === "c" ? card?.confirm : event.key === "o" ? card?.override : event.key === "a" ? card?.answer : undefined;
      if (run !== undefined) {
        event.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actionable, focused]);

  if (repos.isPending || waiting.isPending) return <Loading />;
  if (repos.isError || waiting.isError) return <LoadFailed retry={() => void Promise.all([repos.refetch(), waiting.refetch()])} />;
  if (repos.data.length === 0) return <Welcome />;
  if (items.length === 0 && held.length === 0) return <AllClear repo={repo} now={now} />;

  const repoCount = new Set(items.map((item) => item.repo)).size;
  const parts = [];
  const openQuestions = items.filter((item) => item.call === "ask").length;
  if (openQuestions > 0) parts.push(`${openQuestions} question${openQuestions === 1 ? "" : "s"}`);
  if (items.length - openQuestions > 0) parts.push(`${items.length - openQuestions} call${items.length - openQuestions === 1 ? "" : "s"} to confirm`);
  const confirmRepos = [...new Set(confirms.map((entry) => ("holdUntil" in entry ? entry.item.repo : entry.repo)))].map(shortName);

  const render = (entry: CallView | HeldView) => {
    if ("holdUntil" in entry) {
      return (
        <Receipt
          key={`held-${entry.item.id}`}
          held={entry}
          onUndone={(action) => {
            if (action.type === "overridden") setOverrideOpen(issueKey(entry.item));
          }}
        />
      );
    }
    const key = issueKey(entry);
    return (
      <Card
        key={key}
        item={entry}
        now={now}
        focused={focused === key}
        onFocus={() => setFocused(key)}
        overrideOpen={overrideOpen === key}
        setOverrideOpen={(open) => setOverrideOpen(open ? key : null)}
        register={register}
      />
    );
  };

  return (
    <>
      <div className="page-head">
        <h1>{items.length === 0 ? "Nothing else is waiting on you" : `${items.length} waiting on you`}</h1>
        {parts.length > 0 && (
          <p className="sub">
            {parts.join(" · ")}
            {repoCount > 1 ? ` · across ${repoCount} repos` : ""}
          </p>
        )}
      </div>
      {questions.length > 0 && (
        <section aria-label="Questions">
          <h2 className="group">
            Questions <span>{questions.length}</span>
          </h2>
          <p className="group-note">entail could not tell, or the change is large or hard to undo. Pick go or don’t, and add your own words if you like.</p>
          {questions.map(render)}
        </section>
      )}
      {confirms.length > 0 && (
        <section aria-label="Calls to confirm">
          <h2 className="group">
            Calls to confirm <span>{confirms.length}</span>
          </h2>
          <p className="group-note">Confirm mode is on for {confirmRepos.join(", ")}: these calls are posted on their issues, and entail acts only when you confirm.</p>
          {confirms.map(render)}
        </section>
      )}
      <p className="hint keyline">
        <kbd>j</kbd> <kbd>k</kbd> move · <kbd>c</kbd> confirm · <kbd>o</kbd> override · <kbd>a</kbd> answer · <kbd>Esc</kbd> cancel · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> switch pages
      </p>
    </>
  );
}

/** Oldest first, the items and the receipts together, so a receipt keeps its item's place. */
function order(items: CallView[], held: HeldView[]): (CallView | HeldView)[] {
  const since = (entry: CallView | HeldView) => ("holdUntil" in entry ? entry.item.waitingSince : entry.waitingSince);
  return [...items, ...held].sort((a, b) => since(a).localeCompare(since(b)));
}

function Card(props: {
  item: CallView;
  now: number;
  focused: boolean;
  onFocus: () => void;
  overrideOpen: boolean;
  setOverrideOpen: (open: boolean) => void;
  register: (key: string, handlers: Handlers | null) => void;
}) {
  const { item, now, focused, onFocus, overrideOpen, setOverrideOpen, register } = props;
  const act = useAct(item, () => {
    actedThisVisit = true;
    setOverrideOpen(false);
  });
  const answerInput = useRef<HTMLInputElement>(null);
  const key = issueKey(item);
  const confirming = act.isPending && act.variables?.kind === "confirm";
  const busy = act.isPending;

  useEffect(() => {
    register(key, {
      ...(item.call !== "ask"
        ? {
            confirm: () => {
              if (!busy && !overrideOpen) act.mutate({ kind: "confirm" });
            },
            override: () => setOverrideOpen(true),
          }
        : { answer: () => answerInput.current?.focus() }),
    });
    return () => register(key, null);
  }, [key, item.call, busy, overrideOpen, act, register, setOverrideOpen]);

  return (
    <article
      className={`item${focused ? " focused" : ""}`}
      data-key={key}
      tabIndex={-1}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("a, button, input, label, select")) onFocus();
      }}
      onFocus={onFocus}
    >
      <Meta item={item} now={now} />
      <h3 className="title">
        <External href={item.pr?.url ?? item.issue.url}>{item.pr?.title ?? item.issue.title}</External>
      </h3>
      <Request text={item.body} />
      <Verdict item={item} />
      {item.call === "ask" ? (
        <AnswerForm item={item} act={act} inputRef={answerInput} />
      ) : (
        <>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => act.mutate({ kind: "confirm" })} disabled={busy || overrideOpen}>
              {confirming ? (
                <>
                  <Spinner />
                  {pendingVerb("confirm")}
                </>
              ) : (
                confirmLabel(item)
              )}
            </button>
            <button type="button" className="btn" onClick={() => setOverrideOpen(true)} disabled={busy || overrideOpen}>
              Override…
            </button>
            <span className="keys">
              <kbd>c</kbd> confirm <kbd>o</kbd> override
            </span>
          </div>
          {!overrideOpen && act.isError && <ErrorNote error={act.error} onDismiss={() => act.reset()} />}
          {overrideOpen && (
            <OverrideForm
              item={item}
              act={act}
              onCancel={() => {
                act.reset();
                setOverrideOpen(false);
              }}
            />
          )}
        </>
      )}
    </article>
  );
}

function AllClear({ repo, now }: { repo: string | null; now: number }) {
  const waiting = useWaiting();
  const status = useStatus();
  const settings = useSettings();
  const alone = waiting.data?.actedAlone ?? { count: 0, repos: [] };
  return (
    <div className="calm">
      <div className="mark" aria-hidden="true">
        ✓
      </div>
      <h1>Nothing is waiting on you{repo === null ? "" : ` in ${shortName(repo)}`}.</h1>
      {actedThisVisit && <p>That was everything. Your calls go on their issues and into the case book.</p>}
      {alone.count > 0 && (
        <p>
          Since you last looked, entail made {alone.count} call{alone.count === 1 ? "" : "s"} on its own in {alone.repos.map(shortName).join(", ")}, where confirm mode is off. <a href="#/log">Read them in the log</a>
        </p>
      )}
      <p className="small">
        {status.data?.watching === false
          ? "entail is not watching right now: start it with entail run."
          : `Watching ${status.data?.repos ?? 0} repo${status.data?.repos === 1 ? "" : "s"}${status.data?.checkedAt ? ` · checked ${ago(status.data.checkedAt, now)}` : ""}`}
        {settings.data?.notice ? " · you’ll get one line when something new is waiting." : ""}
      </p>
    </div>
  );
}

export function Loading({ cards = 3 }: { cards?: number }) {
  return (
    <div aria-busy="true">
      <div className="page-head">
        <h1 className="muted">Loading…</h1>
      </div>
      {Array.from({ length: cards }, (_, index) => (
        <div className="sk" key={index}>
          <i style={{ width: "30%" }} />
          <i style={{ width: "75%", height: 15 }} />
          <i style={{ width: "92%" }} />
          <i style={{ width: "60%" }} />
        </div>
      ))}
    </div>
  );
}

export function LoadFailed({ retry }: { retry: () => void }) {
  return (
    <div className="calm">
      <h1>entail did not answer.</h1>
      <p>The board reads everything from entail’s own process. Is <code>entail run</code> still going? The page tries again on its own.</p>
      <button type="button" className="btn" onClick={retry}>
        Try again now
      </button>
    </div>
  );
}

export { Spinner };
