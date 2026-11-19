import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, type EnrollResponse, type UntrustedCertificate } from "../api.ts";
import { forgeName } from "../format.ts";
import { REPOS } from "../queries.ts";
import { useDraft, useToast } from "../state.tsx";
import { Spinner } from "./Verdict.tsx";

/** The repo the owner just enrolled, with the issues already open there, so Repos can offer to judge them. */
export const ENROLLED = ["enrolled"] as const;

/**
 * `owner/repo` on GitHub, `github://host/owner/repo` on a GitHub Enterprise
 * Server, `gitlab:group/repo` on gitlab.com with any subgroups between, or
 * `gitlab://host/group/repo` on a self-hosted GitLab.
 */
const REPO = /^(?:[\w.-]+\/[\w.-]+|github:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[\w.-]+\/[\w.-]+|gitlab:(?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/)?[\w.-]+(?:\/[\w.-]+)+)$/iu;

/**
 * A repo as typed, with a github.com or gitlab.com address turned into its
 * name, and a self-hosted GitLab's or GitHub Enterprise Server's address,
 * written after `gitlab:` or `github:`, too.
 */
function typedRepo(value: string): string {
  const repo = value.trim().replace(/\/$/u, "");
  const gitlab = /^https:\/\/gitlab\.com\/(.+?)(?:\/-(?:\/.*)?)?$/iu.exec(repo);
  if (gitlab !== null) return `gitlab:${gitlab[1]}`;
  const selfHosted = /^gitlab:(?:https?:)?\/\/([^/]+)\/(.+?)(?:\/-(?:\/.*)?)?$/iu.exec(repo);
  if (selfHosted !== null) return selfHosted[1]!.toLowerCase() === "gitlab.com" ? `gitlab:${selfHosted[2]}` : `gitlab://${selfHosted[1]}/${selfHosted[2]}`;
  const enterprise = /^github:(?:https?:)?\/\/([^/]+)\/(.+?)(?:\.git)?$/iu.exec(repo);
  if (enterprise !== null) return enterprise[1]!.toLowerCase() === "github.com" ? enterprise[2]! : `github://${enterprise[1]}/${enterprise[2]}`;
  return repo.replace(/^https:\/\/github\.com\//iu, "");
}

export function EnrollForm({ primary }: { primary?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useDraft("enroll");
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [untrusted, setUntrusted] = useState<{ repo: string; found: UntrustedCertificate } | null>(null);
  const [file, setFile] = useState("");
  const enroll = useMutation({
    mutationFn: (repo: string) => api.enroll(repo),
    onSuccess: (response: EnrollResponse) => {
      client.setQueryData(ENROLLED, response);
      setValue("");
      setMessage(null);
      setUntrusted(null);
      toast(`Enrolled ${response.repo.repo}. Confirm mode is on.`);
      void client.invalidateQueries({ queryKey: REPOS });
      void client.invalidateQueries();
      if (window.location.hash !== "#/repos") window.location.hash = "#/repos";
    },
    onError: (error, repo) => {
      if (error instanceof ApiError && error.untrustedCertificate !== null) {
        setUntrusted({ repo, found: error.untrustedCertificate });
        setFile(error.untrustedCertificate.caCertificate ?? "");
        setMessage({ text: `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}. Nothing was enrolled.`, bad: true });
        return;
      }
      setUntrusted(null);
      setMessage({
        text: error instanceof ApiError && !error.network ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}. Nothing was enrolled.` : "entail did not answer, so nothing was enrolled. Try again.",
        bad: true,
      });
    },
  });
  // Only after the owner confirms this host and this file does entail write glab's setting, and then it tries the enroll again.
  const trust = useMutation({
    mutationFn: ({ host, caCertificate }: { host: string; caCertificate: string }) => api.trustCertificate(host, caCertificate),
    onSuccess: () => {
      if (untrusted !== null) enroll.mutate(untrusted.repo);
    },
    onError: (error) => {
      setMessage({ text: error instanceof ApiError && !error.network ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}. glab was not changed.` : "entail did not answer, so glab was not changed. Try again.", bad: true });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const repo = typedRepo(value);
    if (!REPO.test(repo)) {
      setMessage({ text: /^https?:\/\//iu.test(repo) ? "Use owner/repo, for example omkarbhale/entail, or gitlab:group/repo for a GitLab project. For a self-hosted GitLab or a GitHub Enterprise Server, put gitlab: or github: before its address." : "Use owner/repo, for example omkarbhale/entail, github://host/owner/repo on a GitHub Enterprise Server, gitlab:group/repo for a GitLab project, or gitlab://host/group/repo on a self-hosted GitLab.", bad: true });
      return;
    }
    setMessage(null);
    setUntrusted(null);
    enroll.mutate(repo);
  };
  return (
    <>
      <form className="enroll" onSubmit={submit}>
        <label className="sr" htmlFor="enroll-repo">
          Repo to enroll
        </label>
        <input id="enroll-repo" className="field" placeholder="owner/repo, github://host/owner/repo, gitlab:group/repo or gitlab://host/group/repo" value={value} onChange={(event) => setValue(event.target.value)} disabled={enroll.isPending} autoComplete="off" spellCheck={false} />
        <button className={`btn${primary ? " primary" : ""}`} type="submit" disabled={enroll.isPending}>
          {enroll.isPending ? (
            <>
              <Spinner />
              Checking access on {forgeName(typedRepo(value))}…
            </>
          ) : (
            "Enroll"
          )}
        </button>
      </form>
      <p className={`form-msg${message?.bad ? " bad" : ""}`} role="status">
        {message?.text}
      </p>
      {untrusted?.found.fixable === true && (
        <div className="trust-offer" role="group" aria-label="Trust this host's certificate">
          <p>
            entail can set <code>glab</code> to trust <strong>{untrusted.found.host}</strong> for you, then enroll again. It changes <code>glab</code>’s own configuration for that host only, and only if you confirm.
          </p>
          <label htmlFor="trust-file">CA certificate file to trust for {untrusted.found.host}</label>
          <input id="trust-file" className="field" value={file} onChange={(event) => setFile(event.target.value)} placeholder="/path/to/ca.pem" autoComplete="off" spellCheck={false} disabled={trust.isPending || enroll.isPending} />
          <p className="small">
            {untrusted.found.caCertificate === null ? "git names no CA certificate file for this host, so give the absolute path of the file." : "This is the file git is set to trust for this host."} It runs <code>glab config set ca_cert {file.trim() === "" ? "<file>" : file.trim()} --host {untrusted.found.host}</code>.
          </p>
          <button className="btn primary" type="button" disabled={file.trim() === "" || trust.isPending || enroll.isPending} onClick={() => trust.mutate({ host: untrusted.found.host, caCertificate: file.trim() })}>
            Trust {untrusted.found.host} with this file and enroll
          </button>
        </div>
      )}
    </>
  );
}

export function Welcome() {
  return (
    <div className="welcome">
      <h1>entail isn’t watching any repo yet</h1>
      <p>Enroll a repo and entail makes your product call on each new issue: go, no, or one question for you.</p>
      <EnrollForm primary />
      <ol className="small">
        <li>
          entail reads the repo’s <code>VISION.md</code> as your word on what better means. No vision yet? Write one with <code>/vision</code>, or enroll anyway and entail judges on the merits.
        </li>
        <li>It starts in confirm mode: each call is posted on its issue and waits here for you before entail closes or starts anything.</li>
        <li>When it keeps agreeing with you, turn confirm mode off and only questions will wait for you.</li>
      </ol>
    </div>
  );
}
