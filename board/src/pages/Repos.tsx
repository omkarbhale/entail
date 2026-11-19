import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type CheckResponse, type EnrollResponse, type RepoView, type SettingsView, type SuggestingView } from "../api.ts";
import { ENROLLED, EnrollForm, Welcome } from "../components/Enroll.tsx";
import { EFFORTS, MODELS, options, Saved, useSave } from "../components/Save.tsx";
import { External, Spinner } from "../components/Verdict.tsx";
import { ago, forgeName, repoHref } from "../format.ts";
import { REPOS, SETTINGS, useRepos, useSettings } from "../queries.ts";
import { useNow, useToast } from "../state.tsx";
import { LoadFailed, Loading } from "./Waiting.tsx";

/** Repos: the repos entail watches, each with its own settings; the settings for every repo are on Settings. */

export function ReposPage({ showRepo }: { showRepo: (repo: string, page: "waiting" | "log") => void }) {
  const repos = useRepos();
  const settings = useSettings();
  if (repos.isPending || settings.isPending) return <Loading cards={2} />;
  if (repos.isError || settings.isError) return <LoadFailed retry={() => void Promise.all([repos.refetch(), settings.refetch()])} />;
  if (repos.data.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Repos</h1>
        </div>
        <Welcome />
        <ToSettings />
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <h1>Repos</h1>
        <p className="sub">The repos entail watches, each with its own settings.</p>
      </div>
      <ToSettings />
      <ul className="plain">
        {repos.data.map((repo) => (
          <RepoCard key={repo.repo} repo={repo} settings={settings.data} showRepo={showRepo} />
        ))}
      </ul>
      <div className="enroll-card">
        <h2>Enroll a repo</h2>
        <EnrollForm />
      </div>
    </>
  );
}

function RepoCard({ repo, settings, showRepo }: { repo: RepoView; settings: SettingsView; showRepo: (repo: string, page: "waiting" | "log") => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const now = useNow(5000);
  const enrolled = useQuery<EnrollResponse | null>({ queryKey: ENROLLED, queryFn: () => null, enabled: false, initialData: null });
  const fresh = enrolled.data?.repo.repo === repo.repo ? enrolled.data : null;
  const [checkResult, setCheckResult] = useState<{ ok: true; result: CheckResponse } | { ok: false; error: unknown } | null>(null);
  const [offNote, setOffNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const check = useMutation({
    mutationFn: () => api.check(repo.repo),
    onMutate: () => setCheckResult(null),
    onSuccess: (result) => {
      setCheckResult({ ok: true, result });
      void client.invalidateQueries();
    },
    onError: (error) => setCheckResult({ ok: false, error }),
  });
  const confirm = useSave((on: boolean) => api.changeRepo(repo.repo, { confirm: on }));
  // The switch moves at once; it settles on what entail says once it has been read again, or moves back on a failure.
  const asked = confirm.mutation.isPending || confirm.mutation.isSuccess ? confirm.mutation.variables : undefined;
  const confirmOn = asked ?? repo.confirm;
  const { reset } = confirm.mutation;
  useEffect(() => {
    if (confirm.mutation.isSuccess && confirm.mutation.variables === repo.confirm) reset();
  }, [confirm.mutation.isSuccess, confirm.mutation.variables, repo.confirm, reset]);
  const model = useSave((change: { model?: string | null; effort?: string | null }) => api.changeRepo(repo.repo, change));
  const backlog = useMutation({
    mutationFn: () => api.backlog(repo.repo),
    onSuccess: () => void client.invalidateQueries(),
  });
  const unenroll = useMutation({
    mutationFn: () => api.unenroll(repo.repo),
    onSuccess: () => {
      toast(`Unenrolled ${repo.repo}. Its calls stay in the log.`);
      client.setQueryData(REPOS, (data: { repos: RepoView[] } | undefined) => (data === undefined ? data : { repos: data.repos.filter((one) => one.repo !== repo.repo) }));
      void client.invalidateQueries();
    },
  });

  const toggleConfirm = () => {
    const turningOff = confirmOn;
    setOffNote(null);
    confirm.mutation.mutate(!confirmOn, {
      onSuccess: () => {
        const callsWaiting = repo.waiting;
        if (turningOff && callsWaiting > 0) setOffNote(`What is already waiting still waits for you; new calls act at once.`);
      },
    });
  };
  const checking = check.isPending;
  const confirmDescription = confirmOn
    ? "On: every call waits for you here before entail closes or starts anything."
    : "Off: calls act at once and are logged; only questions wait for you.";

  return (
    <li className={`rcard${fresh !== null ? " newrepo" : ""}`}>
      <div className="rhead">
        <External href={repoHref(repo.repo)} className="rname">
          {repo.repo}
        </External>
        <span className="st">
          <span className="dot" />
          {checking ? "checking…" : repo.checkedAt !== null ? `watching · checked ${ago(repo.checkedAt, now)}` : "watching"}
        </span>
        <button type="button" className="btn sm" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? (
            <>
              <Spinner />
              Checking…
            </>
          ) : (
            "Check now"
          )}
        </button>
      </div>
      {repo.failing !== null && (
        <p className="small bad note">
          Failing since {ago(repo.failing.since, now)}: {repo.failing.reason}
        </p>
      )}
      {repo.stalled.map((stalled) => (
        <p key={`${stalled.pr}-${stalled.head}`} className="small bad note">
          Stalled: {stalled.line}
        </p>
      ))}
      {repo.blocked.map((held) => (
        <p key={held.issue} className="small muted note">
          Held:{" "}
          <a href={held.url} target="_blank" rel="noreferrer">
            #{held.issue}
          </a>{" "}
          waits on {held.blockers.join(", ")}; no call until {held.blockers.length === 1 ? "it closes" : "they close"}.
        </p>
      ))}
      {checkResult !== null && <p className="small muted note" role="status">{checkText(checkResult, repo.repo)}</p>}
      {fresh !== null && fresh.openIssues > 0 && !repo.backlogAsked && (
        <p className="small note">
          Enrolled. {fresh.openIssues} open issue{fresh.openIssues === 1 ? " is" : "s are"} already there; entail judges new and edited issues from now on.{" "}
          <button type="button" className="link" onClick={() => backlog.mutate()} disabled={backlog.isPending}>
            {backlog.isPending ? `Asking entail to judge the ${fresh.openIssues}…` : `Also judge the ${fresh.openIssues} open one${fresh.openIssues === 1 ? "" : "s"}`}
          </button>
          {backlog.isError && <span className="bad"> {backlog.error instanceof ApiError ? backlog.error.message : "entail did not answer"}. Try again.</span>}
        </p>
      )}
      {repo.cannotLabel !== null && (
        <p className="small note">
          <span className="bad">entail cannot label issues here:</span> {repo.cannotLabel}. Calls still post and close; issues go without their <code>entail:</code> label.
        </p>
      )}
      {repo.backlogAsked && fresh !== null && <p className="small note">entail is judging the open backlog; each call appears on Waiting and in the log as it is made.</p>}
      <div className="rrow">
        <span className="lbl">Confirm mode</span>
        <span className="val">
          <button type="button" className="switch" role="switch" aria-checked={confirmOn} aria-label={`Confirm mode for ${repo.repo}`} onClick={toggleConfirm} disabled={confirm.mutation.isPending} />
          <span className="small">{confirmDescription}</span>
          <Saved pending={confirm.mutation.isPending} saved={confirm.saved} />
        </span>
      </div>
      {confirmOn && (
        <div className="rrow sub">
          <span />
          <span className="small muted">
            {repo.checked === 0 ? "No calls checked yet." : `You’ve checked ${repo.checked} of its calls here and agreed with ${repo.agreed}.`}
            {repo.suggestConfirmOff && <b> It agrees with you often enough to try confirm mode off.</b>}
          </span>
        </div>
      )}
      {offNote !== null && (
        <div className="rrow sub">
          <span />
          <span className="small">{offNote}</span>
        </div>
      )}
      <div className="rrow">
        <span className="lbl">Model</span>
        <span className="val">
          <select aria-label={`Model for ${repo.repo}`} value={repo.model ?? "default"} onChange={(event) => model.mutation.mutate({ model: event.target.value === "default" ? null : event.target.value })} disabled={model.mutation.isPending}>
            <option value="default">Default · {settings.model}</option>
            {options(MODELS, repo.model ?? MODELS[0]!).map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
          <select aria-label={`Effort for ${repo.repo}`} value={repo.effort ?? "default"} onChange={(event) => model.mutation.mutate({ effort: event.target.value === "default" ? null : event.target.value })} disabled={model.mutation.isPending}>
            <option value="default">Default · {settings.effort}</option>
            {EFFORTS.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
          <Saved pending={model.mutation.isPending} saved={model.saved} />
        </span>
      </div>
      <BaseBranch repo={repo} />
      <GenericCriteria repo={repo} />
      <SuggestWork repo={repo} now={now} showLog={() => showRepo(repo.repo, "log")} />
      <div className="rrow">
        <span className="lbl">Vision</span>
        <span className="val small">
          {repo.vision !== null ? (
            <External href={repo.vision.url}>
              <code>VISION.md</code> at {repo.vision.commit.slice(0, 7)} ↗
            </External>
          ) : repo.calls > 0 ? (
            <span className="muted">No VISION.md yet: entail judges on the merits and cites no line of yours.</span>
          ) : (
            <span className="muted">entail reads VISION.md at each call.</span>
          )}
        </span>
      </div>
      <Pins repo={repo} />
      <div className="rrow">
        <span className="lbl">Calls</span>
        <span className="val small">
          {repo.waiting > 0 && (
            <>
              <a href="#/waiting" onClick={(event) => (event.preventDefault(), showRepo(repo.repo, "waiting"))}>
                {repo.waiting} waiting on you
              </a>{" "}
              ·
            </>
          )}{" "}
          <a href="#/log" onClick={(event) => (event.preventDefault(), showRepo(repo.repo, "log"))}>
            {repo.calls} in the log
          </a>
        </span>
      </div>
      {asking ? (
        <div className="confirmbox">
          <span>
            Stop watching {repo.repo}? {repo.waiting > 0 ? `Its ${repo.waiting} waiting item${repo.waiting === 1 ? " is" : "s are"} withdrawn and nothing more is posted. ` : ""}The log keeps its calls.
          </span>
          <button type="button" className="btn sm danger" onClick={() => unenroll.mutate()} disabled={unenroll.isPending}>
            {unenroll.isPending ? (
              <>
                <Spinner />
                Unenrolling…
              </>
            ) : (
              "Unenroll"
            )}
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setAsking(false)} disabled={unenroll.isPending}>
            Keep it
          </button>
          {unenroll.isError && <span className="bad small">entail did not unenroll it. Try again.</span>}
        </div>
      ) : (
        <div className="rfoot">
          <button type="button" className="btn ghost sm danger" onClick={() => setAsking(true)}>
            Unenroll…
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Suggest work: a run that reads the vision and the product and files what it
 * finds worth doing as issues labelled entail:suggested, with the model and
 * effort picked here. One run per repo at a time; it puts nothing on the board.
 */
function SuggestWork({ repo, now, showLog }: { repo: RepoView; now: number; showLog: () => void }) {
  const client = useQueryClient();
  const [model, setModel] = useState(repo.uses.model);
  const [effort, setEffort] = useState<string>(repo.uses.effort);
  const suggest = useMutation({
    mutationFn: () => api.suggest(repo.repo, { model, effort }),
    onSuccess: () => void client.invalidateQueries(),
  });
  const running = repo.suggesting?.state === "running";
  return (
    <div className="rrow">
      <span className="lbl">Suggest work</span>
      <span className="val small">
        <span className="val">
          <select aria-label={`Model to suggest work for ${repo.repo} with`} value={model} onChange={(event) => setModel(event.target.value)} disabled={running || suggest.isPending}>
            {options(MODELS, model).map((one) => (
              <option key={one}>{one}</option>
            ))}
          </select>
          <select aria-label={`Effort to suggest work for ${repo.repo} with`} value={effort} onChange={(event) => setEffort(event.target.value)} disabled={running || suggest.isPending}>
            {EFFORTS.map((one) => (
              <option key={one}>{one}</option>
            ))}
          </select>
          <button type="button" className="btn sm" onClick={() => suggest.mutate()} disabled={running || suggest.isPending}>
            {running || suggest.isPending ? (
              <>
                <Spinner />
                Suggesting…
              </>
            ) : (
              "Suggest work"
            )}
          </button>
        </span>
        {suggest.isError ? (
          <span className="bad" role="status">
            Not started: {suggest.error instanceof ApiError && !suggest.error.network ? suggest.error.message : "entail did not answer; try again"}.
          </span>
        ) : (
          repo.suggesting !== null && <SuggestingLine suggesting={repo.suggesting} now={now} showLog={showLog} />
        )}
        <span className="muted">
          Reads the vision and the product as they stand and files what it finds worth doing as issues labelled <code>entail:suggested</code>; each then gets the usual call. A big product can take a while.
        </span>
      </span>
    </div>
  );
}

function SuggestingLine({ suggesting, now, showLog }: { suggesting: SuggestingView; now: number; showLog: () => void }) {
  const log = (
    <a href="#/log" onClick={(event) => (event.preventDefault(), showLog())}>
      See the run in the log
    </a>
  );
  switch (suggesting.state) {
    case "running":
      return (
        <span role="status">
          {suggesting.resuming ? "Filing what an earlier run left unfiled…" : `Suggesting, started ${ago(suggesting.since, now)} with ${suggesting.model} at ${suggesting.effort} effort…`}
        </span>
      );
    case "done":
      return (
        <span role="status">
          Last run {ago(suggesting.at, now)}:{" "}
          {suggesting.suggested === 0
            ? "nothing found worth filing. "
            : suggesting.filed === suggesting.suggested
              ? `${suggesting.suggested} suggestion${suggesting.suggested === 1 ? "" : "s"}, all filed as issues. `
              : `${suggesting.suggested} suggestions, ${suggesting.filed} filed as issues so far; the rest are filed on the next run or when entail restarts. `}
          {log}, with what it left out.
        </span>
      );
    case "failed":
      return (
        <span role="status" className="bad">
          Last run {ago(suggesting.at, now)} failed: {suggesting.reason}
        </span>
      );
  }
}

function checkText(outcome: { ok: true; result: CheckResponse } | { ok: false; error: unknown }, repo: string): string {
  if (!outcome.ok) {
    if (outcome.error instanceof ApiError && !outcome.error.network) return `Not checked: ${outcome.error.message}.`;
    return "entail did not answer. Nothing changed; try again.";
  }
  const { result } = outcome;
  if (result.failed) return `Could not reach ${forgeName(repo)}, or a call could not be made. entail tries again on its next pass.`;
  if (result.judged === 0 && result.posted === 0) return "Checked just now: no new or edited issues.";
  const parts = [];
  if (result.judged > 0) parts.push(`${result.judged} new call${result.judged === 1 ? "" : "s"}`);
  if (result.posted > 0) parts.push(`${result.posted} post${result.posted === 1 ? "" : "s"} on ${forgeName(repo)}`);
  return `Checked just now: ${parts.join(", ")}.`;
}

/**
 * The repo's base branch: the branch entail reads the repo and its vision on,
 * follows and merges PRs into and diffs them against. Empty is the forge's
 * default branch.
 */
function BaseBranch({ repo }: { repo: RepoView }) {
  const [branch, setBranch] = useState(repo.baseBranch ?? "");
  useEffect(() => setBranch(repo.baseBranch ?? ""), [repo.baseBranch]);
  const base = useSave((value: string | null) => api.changeRepo(repo.repo, { baseBranch: value }));
  const wanted = branch.trim() === "" ? null : branch.trim();
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (wanted !== repo.baseBranch) base.mutation.mutate(wanted);
  };
  return (
    <form className="rrow" onSubmit={save}>
      <label className="lbl" htmlFor={`base-${repo.repo}`}>
        Base branch
      </label>
      <span className="val">
        <input id={`base-${repo.repo}`} className="field" placeholder={`${forgeName(repo.repo)}’s default branch`} value={branch} onChange={(event) => setBranch(event.target.value)} autoComplete="off" spellCheck={false} />
        <button className="btn sm" type="submit" disabled={base.mutation.isPending || wanted === repo.baseBranch}>
          {wanted === null && repo.baseBranch !== null ? "Use the default" : "Save"}
        </button>
        <Saved pending={base.mutation.isPending} saved={base.saved} />
        <span className="small muted">Where entail reads the repo and its vision, and which PRs it judges and merges.</span>
      </span>
    </form>
  );
}

/**
 * The repo's pins, one topic each: anything touching a pinned topic comes to
 * the owner, and a PR touching a pinned path merges only on their answer.
 * Added and removed here they go to the same file the owner can edit by hand.
 */
function Pins({ repo }: { repo: RepoView }) {
  const [topic, setTopic] = useState("");
  const change = useSave((one: { pin: string } | { unpin: string }) => api.changeRepo(repo.repo, one));
  const wanted = topic.trim();
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (wanted === "") return;
    change.mutation.mutate({ pin: wanted }, { onSuccess: () => setTopic("") });
  };
  return (
    <div className="rrow">
      <span className="lbl">Pins</span>
      <span className="val small">
        {repo.pins.topics.length === 0 && <span className="muted">None pinned.</span>}
        {repo.pins.topics.length > 0 && (
          <ul className="plain pins">
            {repo.pins.topics.map((one) => (
              <li key={one}>
                <span>{one}</span>{" "}
                <button type="button" className="link" aria-label={`Unpin ${one}`} onClick={() => change.mutation.mutate({ unpin: one })} disabled={change.mutation.isPending}>
                  Unpin
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="val" onSubmit={add}>
          <input className="field" aria-label={`Topic to pin for ${repo.repo}`} placeholder="A topic, or a path such as src/billing/" value={topic} onChange={(event) => setTopic(event.target.value)} autoComplete="off" spellCheck={false} />
          <button className="btn sm" type="submit" disabled={change.mutation.isPending || wanted === ""}>
            Pin
          </button>
          <Saved pending={change.mutation.isPending} saved={change.saved} />
        </form>
        <span className="muted">
          Anything touching a pinned topic comes to you, and a PR changing a pinned path merges only on your answer. Kept in <code title={repo.pins.file}>{repo.pins.file.split("/").slice(-3).join("/")}</code>, one topic per line, which you can also edit by hand.
        </span>
      </span>
    </div>
  );
}

/**
 * What every PR in the repo must meet whatever its ticket, one per line: each
 * landing call checks them beside the ticket's own criteria, and each go
 * lists them. Empty is none.
 */
function GenericCriteria({ repo }: { repo: RepoView }) {
  const current = repo.genericCriteria.join("\n");
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);
  const save = useSave((value: string[]) => api.changeRepo(repo.repo, { genericCriteria: value }));
  const wanted = [...new Set(text.split("\n").map((line) => line.trim()).filter((line) => line !== ""))];
  const unchanged = wanted.join("\n") === current;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!unchanged) save.mutation.mutate(wanted);
  };
  return (
    <form className="rrow" onSubmit={submit}>
      <label className="lbl" htmlFor={`generic-${repo.repo}`}>
        Generic criteria
      </label>
      <span className="val">
        <textarea id={`generic-${repo.repo}`} className="field" rows={3} placeholder="One per line, such as: Tests were added or run" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
        <button className="btn sm" type="submit" disabled={save.mutation.isPending || unchanged}>
          {wanted.length === 0 && repo.genericCriteria.length > 0 ? "Clear criteria" : "Save criteria"}
        </button>
        <Saved pending={save.mutation.isPending} saved={save.saved} />
        <span className="small muted">What every PR here must meet, whatever its ticket. Each landing call checks them beside the ticket’s criteria, and each go lists them.</span>
      </span>
    </form>
  );
}

/** Where the settings for every repo are, now that this page holds only each repo's own. */
function ToSettings() {
  return (
    <p className="to-settings small muted">
      The default model and effort, your name, notices, the start command and the backup remote are the same for every repo; change them on <a href="#/settings">Settings</a>.
    </p>
  );
}
export { SETTINGS };
