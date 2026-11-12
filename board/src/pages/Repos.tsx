import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type CheckResponse, type EnrollResponse, type RepoView, type SettingsView } from "../api.ts";
import { ENROLLED, EnrollForm, Welcome } from "../components/Enroll.tsx";
import { External, Spinner } from "../components/Verdict.tsx";
import { ago } from "../format.ts";
import { REPOS, SETTINGS, useRepos, useSettings } from "../queries.ts";
import { useNow, useToast } from "../state.tsx";
import { LoadFailed, Loading } from "./Waiting.tsx";

/** Repos: the repos entail watches and the few settings that change its calls. */

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

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
        <Notices settings={settings.data} />
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <h1>Repos</h1>
        <p className="sub">The repos entail watches, and the few settings that change its calls.</p>
      </div>
      <Defaults settings={settings.data} />
      <ul className="plain">
        {repos.data.map((repo) => (
          <RepoCard key={repo.repo} repo={repo} settings={settings.data} showRepo={showRepo} />
        ))}
      </ul>
      <div className="enroll-card">
        <h2>Enroll a repo</h2>
        <EnrollForm />
      </div>
      <Notices settings={settings.data} />
    </>
  );
}

function options(values: string[], current: string): string[] {
  return values.includes(current) ? values : [current, ...values];
}

/** A settings change with its pending state and a "Saved" that fades. */
function useSave<T>(save: (value: T) => Promise<unknown>) {
  const client = useQueryClient();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: () => {
      setSaved(true);
      void client.invalidateQueries();
    },
    onError: (error) => toast(error instanceof ApiError && !error.network ? `Not saved: ${error.message}.` : "Not saved: entail did not answer. Nothing changed."),
  });
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [saved]);
  return { mutation, saved };
}

function Saved({ pending, saved }: { pending: boolean; saved: boolean }) {
  if (pending) return <Spinner />;
  return saved ? <span className="saved">Saved</span> : null;
}

function Defaults({ settings }: { settings: SettingsView }) {
  const { mutation, saved } = useSave((change: Partial<SettingsView>) => api.changeSettings(change));
  return (
    <div className="global">
      <span className="small muted">Judging with</span>
      <select aria-label="Default model" value={settings.model} onChange={(event) => mutation.mutate({ model: event.target.value })} disabled={mutation.isPending}>
        {options(MODELS, settings.model).map((model) => (
          <option key={model}>{model}</option>
        ))}
      </select>
      <span className="small muted">effort</span>
      <select aria-label="Default effort" value={settings.effort} onChange={(event) => mutation.mutate({ effort: event.target.value as SettingsView["effort"] })} disabled={mutation.isPending}>
        {EFFORTS.map((effort) => (
          <option key={effort}>{effort}</option>
        ))}
      </select>
      <span className="small muted">· the default for every repo</span>
      <Saved pending={mutation.isPending} saved={saved} />
    </div>
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
        <External href={`https://github.com/${repo.repo}`} className="rname">
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
      {checkResult !== null && <p className="small muted note" role="status">{checkText(checkResult)}</p>}
      {fresh !== null && fresh.openIssues > 0 && !repo.backlogAsked && (
        <p className="small note">
          Enrolled. {fresh.openIssues} open issue{fresh.openIssues === 1 ? " is" : "s are"} already there; entail judges new and edited issues from now on.{" "}
          <button type="button" className="link" onClick={() => backlog.mutate()} disabled={backlog.isPending}>
            {backlog.isPending ? `Asking entail to judge the ${fresh.openIssues}…` : `Also judge the ${fresh.openIssues} open one${fresh.openIssues === 1 ? "" : "s"}`}
          </button>
          {backlog.isError && <span className="bad"> {backlog.error instanceof ApiError ? backlog.error.message : "entail did not answer"}. Try again.</span>}
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
      <div className="rrow">
        <span className="lbl">Pins</span>
        <span className="val small">
          {repo.pins.topics.length > 0 ? <span>{repo.pins.topics.join(" · ")}</span> : <span className="muted">None pinned.</span>}
          <span className="muted">
            Read from <code title={repo.pins.file}>{repo.pins.file.split("/").slice(-3).join("/")}</code>, one topic per line; edit the file to change them.
          </span>
        </span>
      </div>
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

function checkText(outcome: { ok: true; result: CheckResponse } | { ok: false; error: unknown }): string {
  if (!outcome.ok) {
    if (outcome.error instanceof ApiError && !outcome.error.network) return `Not checked: ${outcome.error.message}.`;
    return "entail did not answer. Nothing changed; try again.";
  }
  const { result } = outcome;
  if (result.failed) return "Could not reach GitHub, or a call could not be made. entail tries again on its next pass.";
  if (result.judged === 0 && result.posted === 0) return "Checked just now: no new or edited issues.";
  const parts = [];
  if (result.judged > 0) parts.push(`${result.judged} new call${result.judged === 1 ? "" : "s"}`);
  if (result.posted > 0) parts.push(`${result.posted} post${result.posted === 1 ? "" : "s"} on GitHub`);
  return `Checked just now: ${parts.join(", ")}.`;
}

/** The notice and start commands as set, read only; they are changed from the command line. */
function Notices({ settings }: { settings: SettingsView }) {
  const [name, setName] = useState(settings.owner ?? "");
  useEffect(() => setName(settings.owner ?? ""), [settings.owner]);
  const owner = useSave((value: string) => api.changeSettings({ owner: value }));
  const saveName = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== "") owner.mutation.mutate(name.trim());
  };
  return (
    <div className="notice-line">
      <div className="setting">
        <b>Notices.</b> When something starts waiting, entail runs a command with one line and a link (<code>$1</code>, <code>$2</code>), never the question itself. Now: <code id="notice-command">{settings.notice ?? "none"}</code>
        <p className="hint">
          Change it from the command line: <code>entail settings --notice '&lt;command&gt;'</code> (or <code>--notice none</code>), e.g. <code>examples/notice-to-firstmate.sh</code> or <code>examples/notice-to-file.sh</code> in entail’s checkout. The line reads like “entail: 1 question and 3 calls to confirm waiting on you”; the tab title carries the count too.
        </p>
      </div>
      <div className="setting">
        <b>Starting work.</b> When a go acts (at once, or once you confirm it), entail runs a command with the issue, the reason and the criteria as JSON on its standard input, once per issue. Now: <code id="start-command">{settings.start ?? "none"}</code>
        <p className="hint">
          Change it from the command line: <code>entail settings --start '&lt;command&gt;'</code> (or <code>--start none</code>), e.g. <code>examples/start-to-file.sh</code> in entail’s checkout.
        </p>
      </div>
      <form onSubmit={saveName} className="setting">
        <label htmlFor="owner-name">
          <b>Your name.</b> entail’s comments open with “Speaking from {settings.owner ?? "your GitHub name"}’s entail”, and your answers are recorded under it.
        </label>
        <div className="ov-row">
          <input id="owner-name" className="field" placeholder="the GitHub account gh is logged in as" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
          <button className="btn sm" type="submit" disabled={owner.mutation.isPending || name.trim() === "" || name.trim() === (settings.owner ?? "")}>
            Save
          </button>
          <Saved pending={owner.mutation.isPending} saved={owner.saved} />
        </div>
      </form>
    </div>
  );
}

export { SETTINGS };
