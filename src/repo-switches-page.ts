import { CALL_FILTERS, CALLS_PATH } from "./calls-page.ts";
import { createForge as createForgeAdapter } from "./forge/create-forge.ts";
import type { Forge } from "./forge/forge.ts";
import { ForgeWriter, type InFlightWrites } from "./forge-writer.ts";
import { readGlobalSettings } from "./global-settings.ts";
import type { OperationalLog } from "./operational-log.ts";
import { escapeHtml } from "./page.ts";
import { readRepoSettings, REPO_FIELDS } from "./repo-settings.ts";
import { REPO_SETTINGS_PATH } from "./repo-settings-page.ts";
import { recordUnenrollment, removeUnenrollLabels, setPaused } from "./repo-switches.ts";
import { REPOS_PATH } from "./repos-page.ts";
import { TOKEN_FIELD, type FormRequest, type Page, type PageRequest, type Reply } from "./server.ts";
import type { RepoRecord, Store } from "./store.ts";

export const PAUSE_PATH = "/repos/pause";
export const UNENROLL_PATH = "/repos/unenroll";

/** The pause form's fields: the repo, which switch, and which page to go back to. */
export const SWITCH_FIELDS = { repo: REPO_FIELDS.repo, switch: "switch", back: "back" } as const;
export const SWITCHES = { pause: "pause", resume: "resume" } as const;
/** The pages the pause form goes back to; anything else goes back to the Repos page. */
export const SWITCH_BACK = { repos: "repos", settings: "settings" } as const;

export interface RepoSwitchPagesOptions {
  store: Store;
  /** The forge adapter for a repo, through which unenrolling removes labels; the owner's own CLI by default. */
  forgeFor?: (repo: RepoRecord) => Forge;
  /** Where unenrolling's label removals are counted while in flight, so stopping waits for them. */
  inFlight?: InFlightWrites;
  log?: OperationalLog;
}

/**
 * The owner's pause switch and the unenroll confirm screen (spec §15,
 * ADR-0018), reached from the Repos page and each repo's settings page.
 *
 * Pausing or resuming saves a settings version with the owner's name, which
 * takes effect from the next pass. Unenrolling first shows how many tickets
 * are in flight; confirming it cancels them, withdraws their open board items
 * and removes their `entail:` labels, posting no comment and closing nothing.
 */
export function repoSwitchPages(options: RepoSwitchPagesOptions): Page[] {
  const { store } = options;
  const forgeFor = options.forgeFor ?? ((repo: RepoRecord) => createForgeAdapter({ forge: repo.forge, host: repo.host, path: repo.path }));

  return [
    {
      path: PAUSE_PATH,
      async post(request: FormRequest) {
        const repo = enrolledRepo(store, request.form.get(SWITCH_FIELDS.repo));
        if (repo === null) return notEnrolled(request, 404);
        const asked = request.form.get(SWITCH_FIELDS.switch);
        if (asked !== SWITCHES.pause && asked !== SWITCHES.resume) return problem(request, "Pause or resume?", "The form named no switch. Go back and use its button.", 400);
        const owner = readGlobalSettings(store).settings.ownerDisplayName;
        if (owner === null) {
          return problem(request, "Nothing was saved", "Your display name is not set, and every settings version carries it. Set it in the global settings first.", 409);
        }
        const saved = setPaused(store, repo.id, asked === SWITCHES.pause, owner);
        options.log?.info(asked === SWITCHES.pause ? "repo-paused" : "repo-resumed", { repoId: repo.id, settingsVersion: saved?.version ?? null });
        if (request.form.get(SWITCH_FIELDS.back) === SWITCH_BACK.settings) {
          const query = saved === null ? "unchanged=1" : `saved=${saved.version}`;
          return { redirect: `${REPO_SETTINGS_PATH}?${REPO_FIELDS.repo}=${repo.id}&${query}` };
        }
        return { redirect: REPOS_PATH };
      },
    },
    {
      path: UNENROLL_PATH,
      async get(request) {
        const repo = enrolledRepo(store, request.url.searchParams.get(SWITCH_FIELDS.repo));
        if (repo === null) return notEnrolled(request, 404);
        return confirmView(request, store, repo);
      },
      async post(request: FormRequest) {
        const repo = enrolledRepo(store, request.form.get(SWITCH_FIELDS.repo));
        if (repo === null) return notEnrolled(request, 409);
        const owner = readGlobalSettings(store).settings.ownerDisplayName;
        if (owner === null) {
          return problem(request, "Nothing was unenrolled", "Your display name is not set, and the unenrollment records it. Set it in the global settings first.", 409);
        }
        const unenrolled = recordUnenrollment(store, repo, owner);
        options.log?.info("repo-unenrolled", {
          repoId: repo.id,
          unenrollmentId: unenrolled.unenrollment.id,
          cancelled: unenrolled.cancelled.map((c) => c.ticketId),
          withdrawnItems: unenrolled.cancelled.flatMap((c) => (c.withdrawnItemId === null ? [] : [c.withdrawnItemId])),
        });
        const writer = new ForgeWriter(store, forgeFor(repo), repo, owner, options.inFlight);
        const failed = await removeUnenrollLabels(store, repo, writer, options.log);
        return { redirect: `${REPOS_PATH}?unenrolled=${repo.id}${failed > 0 ? `&labels_left=${failed}` : ""}` };
      },
    },
  ];
}

/** The pause or resume button for a repo, posting to {@link PAUSE_PATH}. */
export function pauseForm(request: PageRequest, repo: RepoRecord, paused: boolean, back: keyof typeof SWITCH_BACK): string {
  const label = paused ? "Resume" : "Pause";
  return `<form method="post" action="${PAUSE_PATH}" class="inline">
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
<input type="hidden" name="${SWITCH_FIELDS.repo}" value="${repo.id}">
<input type="hidden" name="${SWITCH_FIELDS.back}" value="${SWITCH_BACK[back]}">
<button type="submit" name="${SWITCH_FIELDS.switch}" value="${paused ? SWITCHES.resume : SWITCHES.pause}">${label}</button>
</form>`;
}

/** The link to a repo's unenroll confirm screen. */
export function unenrollLink(repo: RepoRecord, label = "Unenroll"): string {
  return `<a href="${UNENROLL_PATH}?${SWITCH_FIELDS.repo}=${repo.id}">${escapeHtml(label)}</a>`;
}

function confirmView(request: PageRequest, store: Store, repo: RepoRecord): Reply {
  const inFlight = store.ticketsInFlight(repo.id);
  const onBoard = inFlight.filter((t) => t.state === "on-the-board").length;
  const paused = readRepoSettings(store, repo.id)?.settings.paused === true;
  const count = `${inFlight.length} ${inFlight.length === 1 ? "ticket is" : "tickets are"} in flight`;
  const body = `<h1>Unenroll ${escapeHtml(repo.path)}?</h1>
<p class="notice" role="status" data-in-flight="${inFlight.length}"><strong>${count}</strong> in ${escapeHtml(repo.path)} on ${escapeHtml(repo.host)}${
    onBoard > 0 ? `, ${onBoard} of them on the board` : ""
  }.</p>
${paused ? `<p class="muted">The repo is paused; it can be unenrolled directly.</p>` : ""}
<p>Unenrolling:</p>
<ul>
<li>cancels every ticket in flight, each with a logged call whose reason is "repo unenrolled";</li>
<li>removes entail's <code>entail:</code> labels from those issues, so no executor works from criteria nobody will check;</li>
<li>withdraws the repo's open board items;</li>
<li>stops entail reading and writing in the repo.</li>
</ul>
<p>It posts no comment and closes no issue. The records stay, read-only, on the <a href="${CALLS_PATH}?${CALL_FILTERS.repo}=${repo.id}">Calls page</a>. Enrolling the repo again later takes in only issues opened after that.</p>
<form method="post" action="${UNENROLL_PATH}">
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
<input type="hidden" name="${SWITCH_FIELDS.repo}" value="${repo.id}">
<button type="submit">Unenroll ${escapeHtml(repo.path)}</button> <a href="${REPOS_PATH}">Cancel</a>
</form>`;
  return { status: 200, page: { title: `Unenroll ${repo.path}`, body } };
}

function enrolledRepo(store: Store, asked: string | null): RepoRecord | null {
  const id = asked !== null && /^\d+$/.test(asked) ? Number(asked) : NaN;
  if (!Number.isSafeInteger(id) || !store.isEnrolled(id)) return null;
  return store.getRepo(id);
}

function notEnrolled(request: PageRequest, status: number): Reply {
  return problem(request, "No such enrolled repo", "This repo is not enrolled, or was unenrolled already.", status);
}

function problem(request: PageRequest, title: string, message: string, status: number): Reply {
  const body = `<h1>${escapeHtml(title)}</h1>\n<p class="error" role="alert">${escapeHtml(message)}</p>\n<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
  return { status, page: { title, body } };
}
