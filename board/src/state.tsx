import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * What the board keeps in the page itself: the owner's typed words (kept
 * through a failure, an Undo, or a call judged again after an edit, keyed by
 * issue), a toast line, and a clock for "40s ago".
 */

type Listener = () => void;

export class Drafts {
  readonly #values = new Map<string, string>();
  readonly #listeners = new Set<Listener>();

  get(key: string): string {
    return this.#values.get(key) ?? "";
  }

  set(key: string, value: string): void {
    if (value === "") this.#values.delete(key);
    else this.#values.set(key, value);
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

const DraftsContext = createContext<Drafts>(new Drafts());

export function useDraft(key: string): [string, (value: string) => void] {
  const drafts = useContext(DraftsContext);
  const value = useSyncExternalStore(drafts.subscribe, () => drafts.get(key));
  return [value, useCallback((next: string) => drafts.set(key, next), [drafts, key])];
}

const ToastContext = createContext<(text: string) => void>(() => {});

export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}

export function BoardState({ children, drafts }: { children: ReactNode; drafts?: Drafts }) {
  const store = useMemo(() => drafts ?? new Drafts(), [drafts]);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback((text: string) => {
    setToast({ text, id: Date.now() });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);
  return (
    <DraftsContext.Provider value={store}>
      <ToastContext.Provider value={show}>
        {children}
        <div className={`toast${toast ? " on" : ""}`} role="status" aria-live="polite">
          {toast?.text}
        </div>
      </ToastContext.Provider>
    </DraftsContext.Provider>
  );
}

/** The time now, ticking every `ms`, for relative times that stay true. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

const LOOKED_KEY = "entail.lastLooked";

/** When the owner last opened the board before this visit, read once per page load; this visit is remembered for the next. */
export const lastLooked: string | null = (() => {
  try {
    const previous = window.localStorage.getItem(LOOKED_KEY);
    window.localStorage.setItem(LOOKED_KEY, new Date().toISOString());
    return previous;
  } catch {
    return null;
  }
})();
