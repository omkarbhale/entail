import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type BoardEvent, type WaitingResponse } from "./api.ts";
import { lastLooked } from "./state.tsx";

/** The board's data, each read from entail's API and kept fresh by its events. */

export const WAITING = ["waiting"] as const;
export const REPOS = ["repos"] as const;
export const STATUS = ["status"] as const;
export const SETTINGS = ["settings"] as const;

export function useWaiting() {
  return useQuery({ queryKey: WAITING, queryFn: () => api.waiting(lastLooked) });
}

export function useRepos() {
  return useQuery({ queryKey: REPOS, queryFn: api.repos, select: (data) => data.repos });
}

export function useStatus() {
  return useQuery({ queryKey: STATUS, queryFn: api.status });
}

export function useSettings() {
  return useQuery({ queryKey: SETTINGS, queryFn: api.settings });
}

/** Moves an item into its undo window in the cached Waiting list at once, before entail is read again. */
export function holdInCache(data: WaitingResponse | undefined, held: WaitingResponse["held"][number]): WaitingResponse | undefined {
  if (data === undefined) return data;
  return {
    ...data,
    items: data.items.filter((item) => item.id !== held.item.id),
    held: [...data.held.filter((other) => other.item.id !== held.item.id), held],
  };
}

export function dropHeldFromCache(data: WaitingResponse | undefined, callId: number): WaitingResponse | undefined {
  if (data === undefined) return data;
  return { ...data, held: data.held.filter((other) => other.item.id !== callId) };
}

export type LiveState = "live" | "connecting" | "off";

/**
 * Listens to entail's events and reads again whatever they say changed, so
 * the page stays live without polling and without reloading.
 */
export function useLiveUpdates(): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>(typeof EventSource === "undefined" ? "off" : "connecting");
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/events");
    const refresh = () => {
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        void client.invalidateQueries();
      }, 120);
    };
    source.onopen = () => {
      setState("live");
      // Anything missed while the connection was down is read again.
      refresh();
    };
    source.onerror = () => setState("connecting");
    source.onmessage = (message) => {
      let event: BoardEvent;
      try {
        event = JSON.parse(message.data as string) as BoardEvent;
      } catch {
        return;
      }
      if (event.type === "checking") void client.invalidateQueries({ queryKey: STATUS });
      else refresh();
    };
    return () => {
      source.close();
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, [client]);
  return state;
}
