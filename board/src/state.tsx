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
/** The owner's chosen theme; read before first paint by `public/theme.js`, which names the same key. */
export const THEME_KEY = "entail.theme";

export type Theme = "light" | "dark";

function systemTheme(): Theme {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

/** The board's theme: the system's until the owner picks one, which is remembered and wins from then on. */
export function useTheme(): [Theme, () => void] {
  const [chosen, setChosen] = useState<Theme | null>(storedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => {
    if (chosen === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = chosen;
  }, [chosen]);
  const theme = chosen ?? system;
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setChosen(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Without storage the choice lasts the visit.
    }
  };
  return [theme, toggle];
}

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
