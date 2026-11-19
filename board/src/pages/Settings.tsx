import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type SettingsChange, type SettingsView } from "../api.ts";
import { EFFORTS, MODELS, options, Saved, useSave } from "../components/Save.tsx";
import { ago } from "../format.ts";
import { useSettings } from "../queries.ts";
import { useNow } from "../state.tsx";
import { LoadFailed, Loading } from "./Waiting.tsx";

/**
 * Settings: every setting `entail settings` changes for every repo, and
 * nothing else. Changing one is not a product decision, so nothing here is
 * posted or listed as a board item; it is written to the settings as the
 * command line writes it.
 */
export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <Loading cards={2} />;
  if (settings.isError) return <LoadFailed retry={() => void settings.refetch()} />;
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p className="sub">
          The settings for every repo, the same ones <code>entail settings</code> changes. Each repo’s own confirm mode, model and effort are on its card on <a href="#/repos">Repos</a>.
        </p>
      </div>
      <div className="settings">
        <Defaults settings={settings.data} />
        <OwnerName settings={settings.data} />
        <Command
          name="notice"
          title="Notices"
          value={settings.data.notice}
          what={
            <>
              When something starts waiting, entail runs this command with one line and a link (<code>$1</code>, <code>$2</code>), never the question itself. The line reads like “entail: 1 question and 3 calls to confirm waiting on you”; the tab title carries the count too.
            </>
          }
          example={
            <>
              For example <code>examples/notice-to-file.sh</code> or <code>examples/notice-to-firstmate.sh</code> in entail’s checkout.
            </>
          }
        />
        <Command
          name="start"
          title="Starting work"
          value={settings.data.start}
          what={<>When a go acts (at once, or once you confirm it), entail runs this command with the issue, the reason and the criteria as JSON on its standard input, once per issue.</>}
          example={
            <>
              For example <code>examples/start-to-file.sh</code> in entail’s checkout.
            </>
          }
        />
        <Command
          name="sendBack"
          title="Sending back"
          value={settings.data.sendBack}
          what={<>When entail sends a PR back or cancels it, it runs this command once, after the comment is posted, with the repo, the PR, the issue, the judged head, what needs to change and the checklist as JSON on its standard input. Whatever the command does never changes the call.</>}
          example={
            <>
              For example <code>examples/send-back-to-file.sh</code> in entail’s checkout.
            </>
          }
        />
        <Backup backup={settings.data.backup} />
      </div>
      <p className="hint run-note">
        How entail is started, <code>entail run --port</code> and <code>--interval</code>, is not a setting: it stays on the command line, or in the service <code>entail service install</code> sets up.
      </p>
    </>
  );
}

function Defaults({ settings }: { settings: SettingsView }) {
  const { mutation, saved } = useSave((change: SettingsChange) => api.changeSettings(change));
  return (
    <div className="setting">
      <b>Judging.</b> The model and effort every repo judges with, unless its card names its own.
      <div className="ov-row">
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
        <Saved pending={mutation.isPending} saved={saved} />
      </div>
    </div>
  );
}

function OwnerName({ settings }: { settings: SettingsView }) {
  const [name, setName] = useState(settings.owner ?? "");
  useEffect(() => setName(settings.owner ?? ""), [settings.owner]);
  const owner = useSave((value: string) => api.changeSettings({ owner: value }));
  const saveName = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== "") owner.mutation.mutate(name.trim());
  };
  return (
    <form onSubmit={saveName} className="setting">
      <label htmlFor="owner-name">
        <b>Your name.</b> entail’s comments open with “Speaking from {settings.owner ?? "your GitHub or GitLab name"}’s entail”, and your answers are recorded under it.
      </label>
      <div className="ov-row">
        <input id="owner-name" className="field" placeholder="the GitHub account gh is logged in as, else the GitLab account glab is" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        <button className="btn sm" type="submit" disabled={owner.mutation.isPending || name.trim() === "" || name.trim() === (settings.owner ?? "")}>
          Save
        </button>
        <Saved pending={owner.mutation.isPending} saved={owner.saved} />
      </div>
    </form>
  );
}

const SHELL_NOTE = "entail runs it with the shell, as you, on this machine.";

/** The backup remote, with how its last push went; any password in it is hidden, so Edit starts it empty then. */
function Backup({ backup }: { backup: SettingsView["backup"] }) {
  const now = useNow();
  const hidden = backup.remote !== null && backup.remote.includes("***");
  return (
    <Editable
      name="backup"
      title="Backup"
      value={backup.remote}
      prefill={hidden ? "" : (backup.remote ?? "")}
      what={<>After each pass entail commits its log, your case book, the settings and the pins, and pushes them to a git remote with your own git and its credentials.</>}
      note={hidden ? "A password in the remote is hidden here; Edit starts empty, so give the whole remote again." : "entail pushes there as you, with your own git."}
      status={
        <>
          {backup.remote !== null && backup.problem === null && <span className="muted">{backup.pushedAt === null ? "no push yet" : `last pushed ${ago(backup.pushedAt, now)}`}</span>}
          {backup.problem !== null && (
            <span className="small bad" role="status">
              Backup {backup.problem.kind === "stuck" ? "stuck" : "failing"} since {ago(backup.problem.since, now)}: {backup.problem.reason}.
            </span>
          )}
        </>
      }
      confirm={(next) => (next === null ? <span>entail will back up to no remote.</span> : <span>entail will push its records to <code>{next}</code> after each pass.</span>)}
      example={
        <>
          For example <code>git@github.com:you/entail-records.git</code>, a private repository. A new machine restores from it with <code>entail restore &lt;git remote url&gt;</code>.
        </>
      }
    />
  );
}

/** A command entail runs with the shell as the owner. */
function Command({ name, title, value, what, example }: { name: "notice" | "start" | "sendBack"; title: string; value: string | null; what: ReactNode; example: ReactNode }) {
  return (
    <Editable
      name={name}
      title={title}
      value={value}
      prefill={value ?? ""}
      what={what}
      note={SHELL_NOTE}
      confirm={(next) =>
        next === null ? (
          <span>entail will run no {name} command.</span>
        ) : (
          <span>
            entail will run <code>{next}</code> with the shell, as you.
          </span>
        )
      }
      example={example}
    />
  );
}

/**
 * A setting that acts as the owner on this machine: shown verbatim and read
 * only until Edit, and saved only on a second click that says what it will be.
 */
function Editable(props: {
  name: "notice" | "start" | "sendBack" | "backup";
  title: string;
  value: string | null;
  prefill: string;
  what: ReactNode;
  note: string;
  status?: ReactNode;
  confirm: (next: string | null) => ReactNode;
  example: ReactNode;
}) {
  const { name, title, value } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setEditing(false);
    setConfirming(false);
  };
  const save = useSave((next: string | null) => api.changeSettings({ [name]: next }), close);
  const next = draft.trim() === "" ? null : draft.trim();
  const label = name === "backup" ? "backup remote" : `${title.toLowerCase()} command`;
  return (
    <div className="setting">
      <b>{title}.</b> {props.what}
      <p className="hint shell-note">{props.note}</p>
      {!editing ? (
        <div className="ov-row">
          <span>
            Now: <code id={name === "backup" ? "backup-remote" : `${name}-command`}>{value ?? "none"}</code>
          </span>
          {props.status}
          <button
            type="button"
            className="btn sm"
            aria-label={`Edit the ${label}`}
            onClick={() => {
              setDraft(props.prefill);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <Saved pending={false} saved={save.saved} />
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirming) setConfirming(true);
            else save.mutation.mutate(next);
          }}
        >
          <div className="ov-row">
            <input
              className="field mono"
              aria-label={label.charAt(0).toUpperCase() + label.slice(1)}
              placeholder="none"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setConfirming(false);
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={save.mutation.isPending}
              autoFocus
            />
            {!confirming && (
              <button className="btn sm" type="submit" disabled={next === value}>
                Save…
              </button>
            )}
            <button className="btn sm ghost" type="button" onClick={close} disabled={save.mutation.isPending}>
              Cancel
            </button>
          </div>
          {confirming && (
            <div className="confirm-command">
              {props.confirm(next)}
              <button className="btn sm primary" type="submit" disabled={save.mutation.isPending}>
                {next === null ? "Yes, none" : name === "backup" ? "Yes, push there" : "Yes, run it as me"}
              </button>
              <Saved pending={save.mutation.isPending} saved={false} />
            </div>
          )}
          <p className="hint">Leave it empty for none. {props.example}</p>
        </form>
      )}
    </div>
  );
}
