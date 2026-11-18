import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "../api.ts";
import { useToast } from "../state.tsx";
import { Spinner } from "./Verdict.tsx";

/** What the Repos and Settings pages share for changing a setting. */

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The choices for a select, with the current value first when it is not one of them. */
export function options(values: string[], current: string): string[] {
  return values.includes(current) ? values : [current, ...values];
}

/** A settings change with its pending state and a "Saved" that fades. */
export function useSave<T>(save: (value: T) => Promise<unknown>, onSaved?: () => void) {
  const client = useQueryClient();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: () => {
      setSaved(true);
      onSaved?.();
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

export function Saved({ pending, saved }: { pending: boolean; saved: boolean }) {
  if (pending) return <Spinner />;
  return saved ? <span className="saved">Saved</span> : null;
}
