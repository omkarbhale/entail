// Running entail for an acceptance run, and setting it up the way the owner
// does: through its own pages on localhost (ADR-0010, ADR-0018). entail runs
// as a child process with a data directory of the run's own, so a run never
// touches the owner's real entail, and is restarted once in the middle of
// every run (pass check 9).
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/store.ts";
import { FIXTURE_SETTINGS } from "./fixture.ts";
import { formData, parsePage, submitButtons, type Control, type Form, type Page } from "./html.ts";

/** entail's command line, run from the sources as `npm test` runs them. */
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export class EntailError extends Error {}

export interface EntailOptions {
  /** Set as XDG_DATA_HOME: entail's data directory is `<dataHome>/entail`. */
  dataHome: string;
  /** Where entail's standard output and error are appended. */
  logFile: string;
  /**
   * The board port. entail has no flag for it: it listens on the saved global
   * setting, 7419 by default. Another port is saved to a fresh store before
   * the first start, so a second entail can run beside one holding 7419; the
   * settings page then sends it back as it is.
   */
  port: number;
  fetch?: typeof fetch;
}

export const DEFAULT_BOARD_PORT = 7419;

/** One entail, started and stopped as a child process. */
export class EntailProcess {
  readonly dataHome: string;
  readonly dataDirectory: string;
  readonly origin: string;
  readonly #logFile: string;
  readonly #fetch: typeof fetch;
  readonly #port: number;
  #child: ChildProcess | undefined;
  #exited: Promise<number | null> | undefined;
  starts = 0;

  constructor(options: EntailOptions) {
    this.dataHome = options.dataHome;
    this.dataDirectory = join(options.dataHome, "entail");
    this.origin = `http://127.0.0.1:${options.port}`;
    this.#port = options.port;
    this.#logFile = options.logFile;
    this.#fetch = options.fetch ?? fetch;
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  /** Starts `entail run` and waits until its pages answer. */
  async start(timeoutMs = 60_000): Promise<void> {
    if (this.#child) throw new EntailError("entail is already running");
    mkdirSync(this.dataDirectory, { recursive: true });
    if (this.#port !== DEFAULT_BOARD_PORT && this.starts === 0) this.#saveBoardPort();
    const log = createWriteStream(this.#logFile, { flags: "a" });
    log.write(`--- entail start ${this.starts + 1} at ${new Date().toISOString()}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_TEST")));
    const child = spawn(process.execPath, [CLI, "run"], {
      env: { ...env, XDG_DATA_HOME: this.dataHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    this.#exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    this.#exited.then(() => log.end());
    this.#child = child;
    this.starts += 1;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const exited = await Promise.race([this.#exited, sleep(500, "waiting" as const)]);
      if (exited !== "waiting") {
        this.#child = undefined;
        throw new EntailError(`entail exited with ${exited} while starting; see ${this.#logFile}`);
      }
      try {
        const response = await this.#fetch(`${this.origin}/settings`);
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new EntailError(`entail did not answer on ${this.origin} within ${timeoutMs} ms`);
    }
  }

  #saveBoardPort(): void {
    const store = Store.openIn(this.dataDirectory);
    try {
      if (store.latestGlobalSettings() === null) store.saveGlobalSettings({ boardPort: this.#port }, "acceptance harness");
    } finally {
      store.close();
    }
  }

  /** Stops entail with SIGTERM, as the service manager would, and waits for it to exit. */
  async stop(timeoutMs = 120_000): Promise<number | null> {
    const child = this.#child;
    if (!child) return null;
    child.kill("SIGTERM");
    const code = await Promise.race([this.#exited!, sleep(timeoutMs, "timeout" as const)]);
    if (code === "timeout") {
      child.kill("SIGKILL");
      await this.#exited;
      this.#child = undefined;
      throw new EntailError(`entail did not stop within ${timeoutMs} ms of SIGTERM`);
    }
    this.#child = undefined;
    return code;
  }
}

/** The global settings an acceptance run saves, besides the owner's name. */
export interface RunGlobalSettings {
  ownerName: string;
  pollIntervalSeconds: number;
  modelRunLimit: number;
  /** Left as entail's default when undefined. */
  model?: string;
}

export interface RepoToEnroll {
  forge: "github" | "gitlab";
  host: string;
  path: string;
}

/**
 * The owner at entail's pages: reads a page, fills its form the way a person
 * would and presses a button, sending the form's own hidden fields (the
 * per-start token among them) with the page's `Origin`. It never writes to
 * entail's store.
 */
export class OwnerPages {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(origin: string, fetchImpl: typeof fetch = fetch) {
    this.#origin = origin;
    this.#fetch = fetchImpl;
  }

  async get(path: string): Promise<{ url: string; page: Page; html: string }> {
    const url = new URL(path, this.#origin);
    const response = await this.#fetch(url, { redirect: "follow" });
    const html = await response.text();
    if (!response.ok) throw new EntailError(`GET ${url} answered ${response.status}: ${parsePage(html).text.slice(0, 300)}`);
    return { url: response.url || url.href, page: parsePage(html), html };
  }

  async submit(pageUrl: string, form: Form, button: Control | undefined): Promise<{ url: string; page: Page; status: number }> {
    const target = new URL(form.action || pageUrl, pageUrl);
    if (target.origin !== this.#origin) throw new EntailError(`a form posts to another origin: ${target}`);
    const response = await this.#fetch(target, {
      method: "POST",
      body: formData(form, button).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: this.#origin },
      redirect: "follow",
    });
    const html = await response.text();
    return { url: response.url || target.href, page: parsePage(html), status: response.status };
  }

  /** Saves the global settings: the owner's name, the `file` notice connector and the run's pace. */
  async saveGlobalSettings(settings: RunGlobalSettings): Promise<void> {
    const { url, page } = await this.get("/settings");
    const form = formWith(page, "owner_display_name");
    set(form, "owner_display_name", settings.ownerName);
    set(form, "notice_connector", FIXTURE_SETTINGS.noticeConnector);
    set(form, "poll_interval_seconds", String(settings.pollIntervalSeconds));
    set(form, "model_run_limit", String(settings.modelRunLimit));
    if (settings.model !== undefined) set(form, "model", settings.model);
    const result = await this.submit(url, form, button(form, /save settings/i));
    if (result.status >= 400 || /Nothing was saved/.test(result.page.text)) {
      throw new EntailError(`the global settings were not saved: ${result.page.text.slice(0, 500)}`);
    }
  }

  /**
   * Enrolls a repo on the Repos page with the fixture's settings (MVP-1 spec,
   * Testing Decisions: Settings): the generic criterion "the CI job `test`
   * passes" in place of whatever entail proposes, and the vision's origin
   * stated by the owner. Shadow stays off, as enrollment leaves it.
   */
  async enroll(repo: RepoToEnroll): Promise<void> {
    const repos = await this.get("/repos");
    const check = formWith(repos.page, "path");
    set(check, "forge", repo.forge);
    set(check, "host", repo.host);
    set(check, "path", repo.path);
    let result = await this.submit(repos.url, check, button(check, /check the repo/i));
    let review = result.page.forms.find((f) => f.controls.some((c) => c.name === "review"));
    if (!review) throw new EntailError(`the Repos page did not offer to enroll ${repo.path}: ${result.page.text.slice(0, 800)}`);

    // The fixture's one generic criterion replaces every proposed row.
    const [criterion] = FIXTURE_SETTINGS.genericCriteria;
    for (let attempt = 0; ; attempt += 1) {
      const count = Number(review.controls.find((c) => c.name === "gc_count")?.value ?? "0");
      let blank: number | undefined;
      for (let i = 0; i < count; i += 1) {
        const remove = review.controls.find((c) => c.name === `gc_${i}_remove`);
        if (remove) remove.checked = true;
        else if (blank === undefined) blank = i;
      }
      if (blank === undefined) {
        result = await this.submit(result.url, review, button(review, /add a row/i));
        review = formWith(result.page, "review");
        if (attempt > 3) throw new EntailError("the review screen gave no empty generic criteria row");
        continue;
      }
      set(review, `gc_${blank}_sentence`, criterion.sentence);
      set(review, `gc_${blank}_check_kind`, "check_passes");
      set(review, `gc_${blank}_check_argument`, criterion.check.name);
      check1(review, "vision_origin", FIXTURE_SETTINGS.visionOrigin);
      result = await this.submit(result.url, review, visibleButton(review, /^enroll$/i));
      const again = result.page.forms.find((f) => f.controls.some((c) => c.name === "review"));
      if (!again) break;
      // Shown again: a warning to confirm (such as a check not yet seen on the default branch) or a refusal.
      if (attempt >= 2 || /Nothing was enrolled/.test(result.page.text)) {
        throw new EntailError(`enrolling ${repo.path} was refused: ${result.page.text.slice(0, 800)}`);
      }
      review = again;
    }
    const listed = await this.get("/repos");
    if (!listed.page.links.some((link) => link.href.includes("/repos/settings"))) {
      throw new EntailError(`${repo.path} is not listed as enrolled: ${result.page.text.slice(0, 500)}`);
    }
  }

  /** Adds the fixture's pin on the repo's settings page. */
  async pin(repoPath: string): Promise<void> {
    const repos = await this.get("/repos");
    const links = repos.page.links.filter((link) => link.href.includes("/repos/settings"));
    const link = links.find((l) => l.text.includes(repoPath)) ?? (links.length === 1 ? links[0] : undefined);
    if (!link) throw new EntailError(`the Repos page links no settings page for ${repoPath}`);
    const { url, page } = await this.get(link.href);
    const form = formWith(page, "p_count");
    const blank = Number(form.controls.find((c) => c.name === "p_count")!.value) - 1;
    const [pin] = FIXTURE_SETTINGS.pins;
    set(form, `p${blank}_topic`, pin.topic);
    set(form, `p${blank}_paths`, pin.paths.join("\n"));
    const shadow = form.controls.find((c) => c.name === "shadow");
    if (shadow) shadow.checked = FIXTURE_SETTINGS.shadow;
    const result = await this.submit(url, form, button(form, /save settings/i));
    if (result.status >= 400 || /Nothing was saved/i.test(result.page.text)) {
      throw new EntailError(`the pin was not saved: ${result.page.text.slice(0, 500)}`);
    }
    const saved = formWith((await this.get(link.href)).page, "p_count");
    if (!saved.controls.some((c) => c.name.endsWith("_topic") && c.value === pin.topic)) {
      throw new EntailError(`the settings page does not show the pin "${pin.topic}" after saving`);
    }
  }
}

function formWith(page: Page, field: string): Form {
  const form = page.forms.find((f) => f.controls.some((c) => c.name === field));
  if (!form) throw new EntailError(`no form on the page has a "${field}" field: ${page.text.slice(0, 500)}`);
  return form;
}

function set(form: Form, name: string, value: string): void {
  const control = form.controls.find((c) => c.name === name && c.type !== "hidden");
  if (!control) throw new EntailError(`the form has no "${name}" field`);
  if (control.tag === "select" && !control.options.some((o) => o.value === value)) {
    throw new EntailError(`the "${name}" field has no option "${value}"`);
  }
  control.value = value;
}

function check1(form: Form, name: string, value: string): void {
  const radios = form.controls.filter((c) => c.name === name && c.type === "radio");
  const chosen = radios.find((c) => c.value === value);
  if (!chosen) throw new EntailError(`the form has no "${name}" choice "${value}"`);
  for (const radio of radios) radio.checked = radio === chosen;
}

function button(form: Form, label: RegExp): Control {
  const found = submitButtons(form).find((b) => label.test(b.label.trim()));
  if (!found) throw new EntailError(`the form has no button ${label}`);
  return found;
}

/** The last button with the label, skipping a hidden default button placed first for the Enter key. */
function visibleButton(form: Form, label: RegExp): Control {
  const found = submitButtons(form).filter((b) => label.test(b.label.trim())).at(-1);
  if (!found) throw new EntailError(`the form has no button ${label}`);
  return found;
}
