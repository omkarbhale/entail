import { useState, type ReactNode } from "react";
import type { CallView } from "../api.ts";
import { ago, callLabel, forgeName, shortName, shownCall, sizeLine, sourceLabel, subject, type ShownCall } from "../format.ts";

/** The parts every item has, in order: what the ticket was, what entail concluded, why, and what it rests on. */

const CALL_NAMES: Record<ShownCall, string> = { go: "Go", plan: "Go · plan", no: "No", ask: "Ask", merge: "Merge", "send-back": "Send back" };

export function Chip({ call }: { call: ShownCall }) {
  return <span className={`chip c-${call}`}>{CALL_NAMES[call]}</span>;
}

export function External({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

export function Meta({ item, now }: { item: CallView; now: number }) {
  const filed = item.issue?.createdAt;
  return (
    <div className="meta">
      <span className="repo" title={item.repo}>
        {shortName(item.repo)}
      </span>
      <span className="sep">·</span>
      {item.pr === null ? (
        <External href={item.issue!.url}>Issue #{item.issue!.number} ↗</External>
      ) : (
        <>
          <External href={item.pr.url}>PR #{item.pr.number} ↗</External>
          <span className="sep">·</span>
          {item.issue === null ? (
            <span className="tag" title="No cleared ticket is behind this PR: entail judged it on the vision alone, with no criteria.">
              no ticket
            </span>
          ) : (
            <span>
              closes <External href={item.issue.url}>#{item.issue.number}</External>
            </span>
          )}
        </>
      )}
      <span className="sep">·</span>
      <span>{filed !== undefined && item.pr === null ? `filed ${ago(filed, now)}` : `judged ${ago(item.judgedAt, now)}`}</span>
      {item.recheck !== null ? (
        <>
          <span className="sep">·</span>
          <span className="tag" title="VISION.md changed since the earlier call on this issue; entail judged it again under the new vision and the call changed.">
            re-judged after a vision change
          </span>
        </>
      ) : (
        item.rejudged && (
          <>
            <span className="sep">·</span>
            <span className="tag" title={`The ${subject(item)} ${item.pr === null ? "was edited" : "was pushed to"} while this waited; entail judged it again and this call replaced the earlier one.`}>
              re-judged after {item.pr === null ? "an edit" : "a push"}
            </span>
          </>
        )
      )}
    </div>
  );
}

/** The request, quoted and clamped to two lines, with "Show all". */
export function Request({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.trim() === "") return null;
  const long = text.length > 160 || text.includes("\n");
  return (
    <blockquote className={`request${open ? "" : " clamp"}`}>
      <p>{text}</p>
      {long && (
        <button type="button" className="link more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </blockquote>
  );
}

export function Verdict({ item, prefix }: { item: CallView; prefix?: ReactNode }) {
  const size = sizeLine(item);
  return (
    <div className="verdict">
      <div className="vhead">
        {prefix}
        <Chip call={shownCall(item)} />
        <span className="vlabel">{callLabel(item)}</span>
        {size !== "" && <span className="size">{size}</span>}
      </div>
      <VisionChanged item={item} />
      <p className="reason">{item.reason}</p>
      {item.question !== null && (
        <div>
          <span className="k">Why it is a question</span>
          <p className="why">{item.question.why}</p>
        </div>
      )}
      {item.pr === null ? <Criteria item={item} /> : <PullRequestFacts item={item} />}
      <RestsOn item={item} />
    </div>
  );
}

/** On a call a vision change moved: the call before → this one, the passage that moved it, and the PRs that relied on the old text. */
function VisionChanged({ item }: { item: CallView }) {
  const { recheck } = item;
  if (recheck === null) return null;
  const what = recheck.passageKind === "added" ? "The line the change added" : recheck.passageKind === "removed" ? "The line the change removed" : "What changed in the vision";
  return (
    <div className="crit recheck">
      <span className="k">
        Vision changed · <Chip call={recheck.previousCall} /> → <Chip call={item.call} />
      </span>
      <span className="muted small">{what}:</span>
      <blockquote className="request">
        <p>{recheck.passage}</p>
      </blockquote>
      {recheck.pullRequests.length > 0 && (
        <span className="small">
          In-flight work that relied on the old text:{" "}
          {recheck.pullRequests.map((pr, index) => (
            <span key={pr.number}>
              {index > 0 && ", "}
              <External href={pr.url}>PR #{pr.number} ↗</External>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function Criteria({ item }: { item: CallView }) {
  if (item.call === "no") return null;
  const heading = item.call === "ask" ? "Criteria, if you say go" : "Criteria";
  if (item.criteria.length === 0) {
    if (item.call === "ask") return null;
    return (
      <div className="crit">
        <span className="k">{heading}</span>
        <span className="muted small">None beyond solving the problem described.</span>
      </div>
    );
  }
  return (
    <div className="crit">
      <span className="k">{heading}</span>
      <ol>
        {item.criteria.map((criterion, index) => (
          <li key={index}>
            {criterion.criterion} <span className="src" title={criterion.basis}>· {sourceLabel(criterion, item)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What a PR's call adds: the criteria as a checklist, what the forge says (not the PR), and what the PR does beyond its criteria. */
function PullRequestFacts({ item }: { item: CallView }) {
  const pr = item.pr!;
  const met = pr.checklist.filter((check) => check.met).length;
  const { checks } = pr.facts;
  const failing = checks.filter((check) => check.status === "failed").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const ci = checks.length === 0 ? "no CI checks reported" : failing > 0 ? `CI: ${failing} of ${checks.length} checks failed` : pending > 0 ? `CI: ${pending} of ${checks.length} checks still pending` : `CI: all ${checks.length} checks passed`;
  const sorted = (sort: "needed" | "harmless" | "unwanted") => pr.beyond.filter((one) => one.sort === sort).length;
  return (
    <>
      {pr.checklist.length > 0 && (
        <div className="crit">
          <span className="k">
            Criteria · {met} of {pr.checklist.length} met
          </span>
          <ul className="checklist">
            {pr.checklist.map((check, index) => (
              <li key={index}>
                <span className={check.met ? "mark-met" : "mark-unmet"} aria-label={check.met ? "met" : "not met"}>
                  {check.met ? "✓" : "✗"}
                </span>
                <span>
                  {check.criterion}
                  <span className="evidence">{check.evidence}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pr.needsToChange.length > 0 && (
        <div>
          <span className="k">What needs to change</span>
          <ul>
            {pr.needsToChange.map((need, index) => (
              <li key={index}>{need}</li>
            ))}
          </ul>
        </div>
      )}
      {pr.guard !== null && <p className="small">{pr.guard.detail}</p>}
      <p className="forge">
        <span className="k">From {forgeName(item.repo)}, not from the PR</span> {ci} · {pr.facts.touched.vision ? "VISION.md is changed" : "VISION.md is not touched"}
        {pr.facts.touched.pins.length > 0 ? ` · pinned: ${pr.facts.touched.pins.join(", ")}` : ""}
      </p>
      {pr.beyond.length > 0 && (
        <details className="beyond">
          <summary>
            {item.issue === null ? "What it does" : "Beyond the criteria"} · {sorted("needed")} needed · {sorted("harmless")} harmless · {sorted("unwanted")} unwanted
          </summary>
          <ul>
            {pr.beyond.map((one, index) => (
              <li key={index}>
                <b>{one.sort}</b>: {one.change} <span className="muted small">{one.why}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function RestsOn({ item }: { item: CallView }) {
  const { visionLines, cases } = item.restsOn;
  return (
    <div className="rests">
      <span className="k">Rests on</span>
      <ul>
        {visionLines.map((line, index) => (
          <li key={`v${index}`}>
            <q>{line.text.replace(/^>\s*/u, "")}</q>{" "}
            {line.url !== null && (
              <External href={line.url} className="ref">
                {line.line === null ? "VISION.md" : `VISION.md:${line.line}`}
                {item.visionCommit !== null ? ` at ${item.visionCommit.slice(0, 7)}` : ""} ↗
              </External>
            )}
          </li>
        ))}
        {cases.map((past) => (
          <li key={past.slug}>
            <span className="muted">Past case:</span> {past.url === null ? past.title : <External href={past.url}>{past.title}</External>}
          </li>
        ))}
        {visionLines.length === 0 && cases.length === 0 && (
          <li>{item.visionCommit === null ? "On the merits: the repo has no VISION.md." : "On the merits: no vision line speaks to this."}</li>
        )}
      </ul>
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}
