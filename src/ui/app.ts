import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { APP_ASSETS_PATH, BOARD_ANSWER_PATH, BOARD_DATA_PATH, ITEM_PARAM, type AnswerReply, type BoardData, type PageView } from "../app-view.ts";
import { Board, itemPath, type BoardApi } from "./board.ts";
import { Header } from "./header.ts";

/**
 * The board app (ADR-0021): one page that shows every page entail serves.
 * Following a link or sending a form asks the server for the next page as
 * JSON and shows it in place, with no reload; the browser's back and forward
 * buttons move between those pages the same way. While a page loads or a form
 * is in flight, the header says so with a spinner and a bar across the top,
 * and the button pressed shows that it is working until the reply arrives.
 *
 * The board itself is rendered here from its data (src/ui/board.ts). Every
 * other page is HTML the server renders, shown in place.
 */

const JSON_ACCEPT = { Accept: "application/json" } as const;

/** Thrown when the server answers with something other than a page: a refusal, or an error. */
export class ServerAnswer extends Error {}

/** Reads a reply the server sent as JSON, or throws what it said instead. */
async function readJson<T>(response: Response): Promise<T> {
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.startsWith("application/json")) {
    const text = (await response.text()).trim();
    throw new ServerAnswer(text || `entail answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

/** Asks the server for a page as JSON, following any redirect; returns the page and where it ended up. */
async function fetchView(url: string, init: RequestInit = {}): Promise<{ view: PageView; url: string }> {
  const response = await fetch(url, { ...init, headers: { ...JSON_ACCEPT, ...init.headers }, cache: "no-store" });
  return { view: await readJson<PageView>(response), url: response.url || url };
}

/** Whether a click on a link is one the app should follow in place. */
function followable(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return false;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith(APP_ASSETS_PATH)) return false;
  // A link to a place on this same page scrolls there, as it always has.
  if (url.pathname === location.pathname && url.search === location.search && url.hash !== "") return false;
  return true;
}

function relative(url: string): string {
  const u = new URL(url, location.href);
  return `${u.pathname}${u.search}${u.hash}`;
}

function scrollFor(url: string): void {
  const hash = new URL(url, location.href).hash;
  const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

export function App({ boot }: { boot: PageView }): ReactNode {
  const [view, setView] = useState(boot);
  const [path, setPath] = useState(location.pathname);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest navigation is shown, however the replies arrive.
  const latest = useRef(0);

  const show = useCallback((next: PageView, url: string, history: "push" | "replace" | "none") => {
    const where = relative(url);
    if (history === "push" && where !== relative(location.href)) window.history.pushState(null, "", where);
    else if (history === "replace") window.history.replaceState(null, "", where);
    setView(next);
    setPath(new URL(url, location.href).pathname);
    setError(null);
    document.title = `${next.title} · entail`;
    requestAnimationFrame(() => scrollFor(url));
  }, []);

  /** Loads a page in place. */
  const navigate = useCallback(
    async (url: string, history: "push" | "none") => {
      const id = ++latest.current;
      setBusy("Loading…");
      try {
        const loaded = await fetchView(url);
        if (id === latest.current) show(loaded.view, history === "push" ? loaded.url : location.href, history);
      } catch (failure) {
        if (id === latest.current) setError(`This page did not load: ${messageOf(failure)}`);
      } finally {
        if (id === latest.current) setBusy(null);
      }
    },
    [show],
  );

  /** Sends a form the server rendered, showing which button is working until the reply arrives. */
  const submit = useCallback(
    async (form: HTMLFormElement, submitter: HTMLElement | null) => {
      const action = new URL(form.getAttribute("action") || location.href, location.href);
      const fields = new URLSearchParams(new FormData(form, submitter) as unknown as Record<string, string>);
      if (form.method.toLowerCase() !== "post") {
        action.search = fields.toString();
        return navigate(action.href, "push");
      }
      const id = ++latest.current;
      const restore = markPending(form, submitter);
      setBusy("Working…");
      try {
        const sent = await fetchView(action.href, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: fields.toString(),
        });
        // A redirect lands on a page that can be loaded again; any other reply stays at the address it was sent from.
        if (id === latest.current) show(sent.view, sent.url === action.href ? location.href : sent.url, sent.url === action.href ? "none" : "push");
      } catch (failure) {
        restore();
        if (id === latest.current) setError(`Nothing was sent: ${messageOf(failure)}`);
      } finally {
        if (id === latest.current) setBusy(null);
      }
    },
    [navigate, show],
  );

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || !followable(event, anchor)) return;
      event.preventDefault();
      void navigate(anchor.href, "push");
    };
    const onSubmit = (event: SubmitEvent) => {
      // The board's own forms are handled by the board.
      if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      event.preventDefault();
      void submit(event.target, event.submitter);
    };
    const onPop = () => void navigate(location.href, "none");
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener("popstate", onPop);
    };
  }, [navigate, submit]);

  const api = useMemo<BoardApi>(
    () => ({
      load: async (item) => {
        const url = item === null ? BOARD_DATA_PATH : `${BOARD_DATA_PATH}?${ITEM_PARAM}=${item}`;
        return readJson<BoardData>(await fetch(url, { headers: JSON_ACCEPT, cache: "no-store" }));
      },
      answer: async (fields) => {
        const response = await fetch(BOARD_ANSWER_PATH, {
          method: "POST",
          headers: { ...JSON_ACCEPT, "Content-Type": "application/x-www-form-urlencoded" },
          body: fields.toString(),
        });
        return readJson<AnswerReply>(response);
      },
      showItem: (id) => window.history.replaceState(null, "", itemPath(id)),
      busy: setBusy,
    }),
    [],
  );

  return h(
    "div",
    { className: "app" },
    h(Header, { chrome: view.chrome, path, busy }),
    error === null ? null : h("p", { className: "app-error", role: "alert" }, error),
    view.kind === "board"
      ? h("main", { className: "wide", "aria-busy": busy !== null || undefined }, h(Board, { initial: view.data, api }))
      : h("main", { className: view.wide ? "wide" : undefined, "aria-busy": busy !== null || undefined, dangerouslySetInnerHTML: { __html: view.body } }),
  );
}

/** Shows a server-rendered form as in flight: its button says so and nothing in it can be sent again. Returns how to undo that. */
function markPending(form: HTMLFormElement, submitter: HTMLElement | null): () => void {
  const buttons = [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type=submit]")];
  const disabled = buttons.map((b) => b.disabled);
  const label = submitter?.innerHTML ?? "";
  form.setAttribute("aria-busy", "true");
  for (const b of buttons) b.disabled = true;
  if (submitter instanceof HTMLButtonElement) {
    submitter.classList.add("pending");
    submitter.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label}`;
  }
  return () => {
    form.removeAttribute("aria-busy");
    buttons.forEach((b, i) => (b.disabled = disabled[i]!));
    if (submitter instanceof HTMLButtonElement) {
      submitter.classList.remove("pending");
      submitter.innerHTML = label;
    }
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
