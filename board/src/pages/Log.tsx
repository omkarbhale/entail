import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ActionView, type CallView, type HeldView, type LogFilter, type LogRow } from "../api.ts";
import { OverrideForm, Receipt, useAct } from "../components/Actions.tsx";
import { Chip, External, Request, Spinner, Verdict } from "../components/Verdict.tsx";
import { clock, dayLabel, overrideChoices, refNumber, shortName, timeZone } from "../format.ts";
import { useRepos, useWaiting } from "../queries.ts";
import { LoadFailed, Loading } from "./Waiting.tsx";

/**
 * The log: every call entail made, newest first and grouped by day, across
 * repos or for one. An override never replaces entail's call: both stay on
 * the record. Older days page in; nothing is ever trimmed.
 */

const FILTERS: { key: LogFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "waiting", label: "Waiting" },
  { key: "overridden", label: "Overridden" },
  { key: "questions", label: "Questions" },
  { key: "prs", label: "PRs" },
];

export function LogPage({ repo }: { repo: string | null }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const repos = useRepos();
  const log = useInfiniteQuery({
    queryKey: ["log", repo, filter],
    queryFn: ({ pageParam }) => api.log({ repo, filter, before: pageParam, timeZone: timeZone() }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    placeholderData: (previous) => previous,
  });

  if (log.isPending || repos.isPending) return <Loading cards={2} />;
  if (log.isError) return <LoadFailed retry={() => void log.refetch()} />;
  const counts = log.data.pages[0]!.counts;
  if (counts.all === 0) {
    return (
      <div className="page-head">
        <h1>Log</h1>
        <p className="sub">
          Every call entail makes, with its reason. Nothing yet
          {repos.data?.length === 0 ? (
            <>
              : enroll a repo on <a href="#/repos">Repos</a>.
            </>
          ) : (
            ": entail makes a call when an issue is filed or edited."
          )}
        </p>
      </div>
    );
  }
  const rows = log.data.pages.flatMap((page) => page.rows);
  const days = [...new Set(rows.map((row) => row.day))];
  const toggle = (id: number) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <>
      <div className="page-head">
        <h1>Log</h1>
        <p className="sub">
          Every call entail made{repo === null ? " across your repos" : ` in ${repo}`}, newest first, with its reason. Where you overrode a call, both stay on the record.
        </p>
      </div>
      <div className="filters" role="group" aria-label="Filter calls">
        {FILTERS.map((option) => (
          <button type="button" key={option.key} aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>
            {option.label}
            <span className="n">{counts[option.key]}</span>
          </button>
        ))}
      </div>
      <p className="small muted summary">
        {counts.all} call{counts.all === 1 ? "" : "s"} · {counts.waiting} waiting on you · you overrode {counts.overridden}
        {log.isFetching && !log.isFetchingNextPage && (
          <>
            {" "}
            <Spinner />
          </>
        )}
      </p>
      {days.length === 0 ? (
        <ul className="log first">
          <li className="lempty">No calls match.</li>
        </ul>
      ) : (
        days.map((day) => (
          <section key={day} aria-label={dayLabel(day)}>
            <h2 className="day">{dayLabel(day)}</h2>
            <ul className="log">
              {rows
                .filter((row) => row.day === day)
                .map((row) => (
                  <Row key={row.call.id} row={row} open={open.has(row.call.id)} toggle={() => toggle(row.call.id)} />
                ))}
            </ul>
          </section>
        ))
      )}
      {log.hasNextPage && (
        <div className="more-days">
          <button type="button" className="btn" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            {log.isFetchingNextPage ? (
              <>
                <Spinner />
                Reading earlier days…
              </>
            ) : (
              "Earlier days"
            )}
          </button>
        </div>
      )}
    </>
  );
}

const OWNER_CALL_WORDS = { go: "Go ahead", no: "Don’t go ahead", merge: "Merge it", "send-back": "Send it back" } as const;

function Status({ row }: { row: LogRow }) {
  const { call } = row;
  const by = call.settledBy?.by ?? "you";
  const ownerCall = call.settledBy?.to ?? "go";
  switch (call.status) {
    case "waiting":
      return <span className="st wait">Waiting for you</span>;
    case "confirmed":
      return <span className="st">Confirmed by {by}</span>;
    case "answered":
      return (
        <>
          <span className="arrow">→</span>
          <Chip call={ownerCall} />
          <span className="st">Answered by {by}</span>
        </>
      );
    case "overridden":
      return (
        <>
          <span className="arrow">→</span>
          <Chip call={ownerCall} />
          <span className="st over">{call.settledBy?.differently === true ? `Made differently by ${by}` : `Overridden by ${by}`}</span>
        </>
      );
    case "auto":
      return <span className="st">{row.reopened ? "Acted at once · reopened on GitHub" : "Acted at once"}</span>;
    case "superseded":
      return <span className="st">{call.pr === null ? "Replaced after an edit" : "Replaced after a push"}</span>;
    case "closed":
      return <span className="st">PR merged or closed before you decided</span>;
    default:
      return null;
  }
}

function OwnerBlock({ row }: { row: LogRow }) {
  const action = row.call.settledBy;
  if (action === null) return null;
  const words = action.reason ?? action.answer;
  if (action.type === "confirmed") {
    return (
      <div className="owner">
        <b>Confirmed by {action.by}</b> <span className="muted small">{clock(action.at)}</span>
      </div>
    );
  }
  const call = action.to ?? "go";
  const head = action.type === "answered" ? `Answered by ${action.by}` : action.differently === true ? `Go, made differently by ${action.by}` : `Overridden by ${action.by}`;
  return (
    <div className={`owner${action.type === "overridden" ? " over" : ""}`}>
      <div className="vhead">
        <b>{head}</b>
        <span className="muted small">{clock(action.at)}</span>
      </div>
      <div className="owner-call">
        <Chip call={call} /> <b>{OWNER_CALL_WORDS[call]}</b>
      </div>
      {words !== undefined && <q>{words}</q>}
      {row.ownerCall !== null && row.ownerCall.criteria.length > 0 && (
        <div className="crit">
          <span className="k">Criteria posted with {action.by}’s go</span>
          <ol>
            {row.ownerCall.criteria.map((criterion, index) => (
              <li key={index}>{criterion.criterion}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Row({ row, open, toggle }: { row: LogRow; open: boolean; toggle: () => void }) {
  const { call } = row;
  const firstLine = call.call === "ask" ? (call.question?.question ?? call.reason) : call.reason;
  return (
    <li className="lrow">
      <button type="button" className="lsum" onClick={toggle} aria-expanded={open}>
        <span className="ltime">{clock(call.judgedAt)}</span>
        <span className="lmain">
          <span className="lline">
            <span className="lref">
              <b>{shortName(call.repo)}</b> {call.pr === null ? "" : "PR "}#{refNumber(call)}
            </span>
            <span className="ltitle">{call.pr?.title ?? call.issue.title}</span>
          </span>
          <span className="lreason">{firstLine}</span>
        </span>
        <span className="lright">
          <Chip call={call.call} />
          <Status row={row} />
        </span>
      </button>
      {open && <Detail row={row} />}
    </li>
  );
}

function Detail({ row }: { row: LogRow }) {
  const { call } = row;
  const [overriding, setOverriding] = useState(false);
  const waiting = useWaiting();
  const held = waiting.data?.held.find((one) => one.item.id === call.id);
  const [recorded, setRecorded] = useState<HeldView | null>(null);
  const act = useAct(call, (action: ActionView) => {
    setOverriding(false);
    if (action.holdUntil !== undefined) setRecorded({ item: call, action, holdUntil: action.holdUntil });
  });
  // A call entail acted on at once can still be overridden after the fact, through the same one-line form.
  const canOverride = call.status === "auto" && call.call !== "ask";
  const receipt = held ?? recorded;
  return (
    <div className="ldetail">
      <Request text={call.body} />
      <Verdict item={call} prefix={<span className="who">entail</span>} />
      <OwnerBlock row={row} />
      <ul className="trail">
        {row.trail.map((step, index) => (
          <li key={index}>
            <span className="tt">{clock(step.at)}</span>
            <span>
              {step.text}
              {step.url !== undefined && (
                <>
                  {" "}
                  <External href={step.url}>↗</External>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="actions">
        <External href={call.pr?.url ?? call.issue.url} className="btn sm">
          Open {call.pr === null ? "issue" : "PR"} on GitHub ↗
        </External>
        {call.status === "waiting" && (
          <a className="btn sm" href="#/waiting">
            Decide it in Waiting
          </a>
        )}
        {canOverride && !overriding && receipt === null && (
          <button type="button" className="btn sm" onClick={() => setOverriding(true)}>
            Override this call…
          </button>
        )}
      </div>
      {receipt !== null && receipt !== undefined && <Receipt held={receipt} onUndone={() => setRecorded(null)} onGone={() => setRecorded(null)} />}
      {canOverride && overriding && overrideChoices(call).length > 0 && <OverrideForm item={call as CallView} act={act} onCancel={() => setOverriding(false)} />}
    </div>
  );
}
