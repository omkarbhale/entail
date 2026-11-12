import { QueryClient, QueryClientProvider, useIsFetching } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ago, shortName } from "./format.ts";
import { LogPage } from "./pages/Log.tsx";
import { ReposPage } from "./pages/Repos.tsx";
import { WaitingPage } from "./pages/Waiting.tsx";
import { useLiveUpdates, useRepos, useStatus, useWaiting, type LiveState } from "./queries.ts";
import { BoardState, useNow, type Drafts } from "./state.tsx";

/**
 * entail's board: three pages on hash routes (#/waiting, #/log, #/repos),
 * moving between them and acting on items without ever reloading the page.
 */

export type Page = "waiting" | "log" | "repos";

function pageOf(hash: string): Page {
  const match = /^#\/(waiting|log|repos)\b/u.exec(hash);
  return (match?.[1] as Page | undefined) ?? "waiting";
}

export function useHashPage(): Page {
  const [page, setPage] = useState<Page>(() => pageOf(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setPage(pageOf(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return page;
}

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: 1, retryDelay: 1_500, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

export function App({ client, drafts }: { client?: QueryClient; drafts?: Drafts }) {
  const [queryClient] = useState(() => client ?? newQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <BoardState {...(drafts ? { drafts } : {})}>
        <Board />
      </BoardState>
    </QueryClientProvider>
  );
}

const REPO_KEY = "entail.repo";

function savedRepo(): string | null {
  try {
    return window.localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
}

function Board() {
  const page = useHashPage();
  const live = useLiveUpdates();
  const repos = useRepos();
  const waiting = useWaiting();
  const [repo, setRepoState] = useState<string | null>(savedRepo);
  const setRepo = (next: string | null) => {
    setRepoState(next);
    try {
      if (next === null) window.localStorage.removeItem(REPO_KEY);
      else window.localStorage.setItem(REPO_KEY, next);
    } catch {
      // The filter is only a convenience; without storage it lasts the visit.
    }
  };
  // A repo that is no longer enrolled is no longer a filter.
  const filter = repo !== null && repos.data !== undefined && !repos.data.some((one) => one.repo === repo) ? null : repo;
  const count = waiting.data?.items.length ?? 0;

  useEffect(() => {
    document.title = count > 0 ? `(${count}) entail` : "entail";
  }, [count]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select") || event.metaKey || event.ctrlKey || event.altKey) return;
      const to = ({ "1": "#/waiting", "2": "#/log", "3": "#/repos" } as Record<string, string>)[event.key];
      if (to !== undefined) window.location.hash = to;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showRepo = (name: string, to: "waiting" | "log") => {
    setRepo(name);
    window.location.hash = `#/${to}`;
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <a className="brand" href="#/waiting">
            entail
          </a>
          <nav className="nav" aria-label="Board">
            <NavLink page="waiting" current={page}>
              Waiting <span className={`count${count === 0 ? " zero" : ""}`}>{count}</span>
            </NavLink>
            <NavLink page="log" current={page}>
              Log
            </NavLink>
            <NavLink page="repos" current={page}>
              Repos
            </NavLink>
          </nav>
          <div className="top-right">
            {page !== "repos" && (repos.data?.length ?? 0) > 0 && (
              <>
                <label className="sr" htmlFor="repo-filter">
                  Show repos
                </label>
                <select id="repo-filter" value={filter ?? "all"} onChange={(event) => setRepo(event.target.value === "all" ? null : event.target.value)}>
                  <option value="all">All repos</option>
                  {repos.data!.map((one) => (
                    <option key={one.repo} value={one.repo}>
                      {one.repo}
                    </option>
                  ))}
                </select>
              </>
            )}
            <Sync live={live} />
          </div>
          <Progress />
        </div>
      </header>
      <main id="main">
        {page === "waiting" && <WaitingPage repo={filter} />}
        {page === "log" && <LogPage repo={filter} />}
        {page === "repos" && <ReposPage showRepo={showRepo} />}
      </main>
    </>
  );
}

function NavLink({ page, current, children }: { page: Page; current: Page; children: ReactNode }) {
  return (
    <a href={`#/${page}`} aria-current={page === current ? "page" : undefined}>
      {children}
    </a>
  );
}

/** Whether entail is watching, and when it last checked: the board's one line of health. */
function Sync({ live }: { live: LiveState }) {
  const status = useStatus();
  const now = useNow();
  let text: string;
  let tone = "";
  if (status.isError) {
    text = "entail is not answering";
    tone = "off";
  } else if (status.data === undefined) {
    text = "connecting…";
    tone = "off";
  } else if (!status.data.watching) {
    text = "not watching: start entail run";
    tone = "off";
  } else if (status.data.repos === 0) {
    text = "not watching any repo";
    tone = "off";
  } else {
    const repos = `watching ${status.data.repos} repo${status.data.repos === 1 ? "" : "s"}`;
    text = status.data.checking ? `${repos} · checking…` : status.data.checkedAt ? `${repos} · checked ${ago(status.data.checkedAt, now)}` : repos;
    if (live === "connecting") {
      text = `${repos} · reconnecting…`;
      tone = "off";
    }
  }
  return (
    <span className="sync" title={live === "live" ? "Live: the board updates as entail works" : undefined}>
      <span className={`dot${tone === "off" ? " off" : ""}`} />
      <span>{text}</span>
    </span>
  );
}

/** A thin bar under the top bar while anything is being read. */
function Progress() {
  const fetching = useIsFetching();
  return <div className={`progress${fetching > 0 ? " on" : ""}`} aria-hidden="true" />;
}

export { shortName };
