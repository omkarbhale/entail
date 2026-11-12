import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, type EnrollResponse } from "../api.ts";
import { REPOS } from "../queries.ts";
import { useDraft, useToast } from "../state.tsx";
import { Spinner } from "./Verdict.tsx";

/** The repo the owner just enrolled, with the issues already open there, so Repos can offer to judge them. */
export const ENROLLED = ["enrolled"] as const;

const REPO = /^[\w.-]+\/[\w.-]+$/u;

export function EnrollForm({ primary }: { primary?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useDraft("enroll");
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const enroll = useMutation({
    mutationFn: (repo: string) => api.enroll(repo),
    onSuccess: (response: EnrollResponse) => {
      client.setQueryData(ENROLLED, response);
      setValue("");
      setMessage(null);
      toast(`Enrolled ${response.repo.repo}. Confirm mode is on.`);
      void client.invalidateQueries({ queryKey: REPOS });
      void client.invalidateQueries();
      if (window.location.hash !== "#/repos") window.location.hash = "#/repos";
    },
    onError: (error) => {
      setMessage({
        text: error instanceof ApiError && !error.network ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}. Nothing was enrolled.` : "entail did not answer, so nothing was enrolled. Try again.",
        bad: true,
      });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const repo = value.trim().replace(/^https:\/\/github\.com\//u, "").replace(/\/$/u, "");
    if (!REPO.test(repo)) {
      setMessage({ text: "Use owner/repo, for example omkarbhale/entail.", bad: true });
      return;
    }
    setMessage(null);
    enroll.mutate(repo);
  };
  return (
    <>
      <form className="enroll" onSubmit={submit}>
        <label className="sr" htmlFor="enroll-repo">
          Repo to enroll
        </label>
        <input id="enroll-repo" className="field" placeholder="owner/repo" value={value} onChange={(event) => setValue(event.target.value)} disabled={enroll.isPending} autoComplete="off" spellCheck={false} />
        <button className={`btn${primary ? " primary" : ""}`} type="submit" disabled={enroll.isPending}>
          {enroll.isPending ? (
            <>
              <Spinner />
              Checking access on GitHub…
            </>
          ) : (
            "Enroll"
          )}
        </button>
      </form>
      <p className={`form-msg${message?.bad ? " bad" : ""}`} role="status">
        {message?.text}
      </p>
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
