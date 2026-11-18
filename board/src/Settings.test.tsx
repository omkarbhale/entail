import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "./api.ts";
import { fakeApi, renderBoard } from "./test-support.tsx";

/** An EventSource the test drives, standing in for entail's `/api/events`. */
class FakeEvents {
  static last: FakeEvents | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  constructor() {
    FakeEvents.last = this;
  }
  close() {}
}

/** The fake API, saving a settings change as entail does. */
function settingsApi(initial: Partial<SettingsView> = {}) {
  const api = fakeApi();
  api.state.settings = { ...api.state.settings, ...initial };
  api.route((method, path, body) => {
    if (method !== "PATCH" || path !== "/api/settings") return undefined;
    api.state.settings = { ...api.state.settings, ...body };
    return { status: 200, body: api.state.settings };
  });
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEvents.last = null;
});

describe("Settings", () => {
  it("shows every setting for every repo, says where each repo's own are, and that how entail is started is not one", async () => {
    settingsApi({ notice: "examples/notice-to-file.sh", start: "examples/start-to-file.sh 'a b'" });
    renderBoard("#/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect((screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement).value).toBe("claude-opus-5-5");
    expect((screen.getByRole("combobox", { name: "Default effort" }) as HTMLSelectElement).value).toBe("low");
    expect((screen.getByRole("textbox", { name: /Your name\./u }) as HTMLInputElement).value).toBe("Omkar");
    expect(document.getElementById("notice-command")!.textContent).toBe("examples/notice-to-file.sh");
    expect(document.getElementById("start-command")!.textContent).toBe("examples/start-to-file.sh 'a b'");
    expect(screen.getAllByText("entail runs it with the shell, as you, on this machine.")).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "Notices command" })).toBeNull();
    expect(within(document.querySelector("main")!).getByRole("link", { name: "Repos" }).getAttribute("href")).toBe("#/repos");
    expect(screen.getByText(/is not a setting: it stays on the command line/u)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Show repos" })).toBeNull();
  });

  it("is page 4 on the keyboard", async () => {
    settingsApi();
    renderBoard("#/waiting");
    await screen.findByRole("heading", { name: /waiting/iu });
    await userEvent.keyboard("4");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  });

  it("saves the default model and effort and your name", async () => {
    const api = settingsApi();
    renderBoard("#/settings");
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Default model" }), "claude-sonnet-5-5");
    await waitFor(() => expect(api.sent(/PATCH \/api\/settings/u)).toHaveLength(1));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Default effort" }), "max");
    const name = screen.getByRole("textbox", { name: /Your name\./u });
    await userEvent.clear(name);
    await userEvent.type(name, "Omkar Bhale");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.sent(/PATCH \/api\/settings/u)).toHaveLength(3));
    expect(api.sent(/PATCH \/api\/settings/u).map((one) => one.body)).toEqual([{ model: "claude-sonnet-5-5" }, { effort: "max" }, { owner: "Omkar Bhale" }]);
    expect(await screen.findByText(/Speaking from Omkar Bhale’s entail/u)).toBeTruthy();
  });

  it("saves a command only on a second click that shows what will run, and Cancel saves nothing", async () => {
    const api = settingsApi();
    renderBoard("#/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Edit the notices command" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notices command" }), "examples/notice-to-file.sh");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(api.sent(/PATCH/u)).toHaveLength(0);
    expect(screen.getByText("examples/notice-to-file.sh", { selector: ".confirm-command code" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.sent(/PATCH/u)).toHaveLength(0);
    expect(document.getElementById("notice-command")!.textContent).toBe("none");

    await userEvent.click(screen.getByRole("button", { name: "Edit the starting work command" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Starting work command" }), "examples/start-to-file.sh");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, run it as me" }));
    await waitFor(() => expect(document.getElementById("start-command")!.textContent).toBe("examples/start-to-file.sh"));
    expect(api.sent(/PATCH \/api\/settings/u).map((one) => one.body)).toEqual([{ start: "examples/start-to-file.sh" }]);
    expect(screen.queryByRole("textbox", { name: "Starting work command" })).toBeNull();
  });

  it("turns a command off with an empty value, confirmed the same way", async () => {
    const api = settingsApi({ notice: "examples/notice-to-file.sh" });
    renderBoard("#/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Edit the notices command" }));
    const field = screen.getByRole("textbox", { name: "Notices command" }) as HTMLInputElement;
    expect(field.value).toBe("examples/notice-to-file.sh");
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(screen.getByText("entail will run no notice command.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Yes, none" }));
    await waitFor(() => expect(document.getElementById("notice-command")!.textContent).toBe("none"));
    expect(api.sent(/PATCH \/api\/settings/u)[0]!.body).toEqual({ notice: null });
  });

  it("shows the backup remote with how its last push went, and says when it is stuck and why", async () => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    settingsApi({ backup: { remote: "git@example.com:me/records.git", pushedAt: since, problem: { kind: "stuck", since, reason: "git@example.com:me/records.git has moved on since entail last pushed (fetch first)" } } });
    renderBoard("#/settings");
    expect((await screen.findByText("git@example.com:me/records.git", { selector: "#backup-remote" })).textContent).toBe("git@example.com:me/records.git");
    expect(screen.getByText(/Backup stuck since .*: git@example\.com:me\/records\.git has moved on since entail last pushed/u)).toBeTruthy();
  });

  it("sets the backup remote on a second click, and starts Edit empty when a password in it is hidden", async () => {
    const api = settingsApi({ backup: { remote: "https://***:***@example.com/me/records.git", pushedAt: null, problem: null } });
    api.route((method, path, body) => {
      if (method !== "PATCH" || path !== "/api/settings") return undefined;
      api.state.settings = { ...api.state.settings, backup: { remote: body.backup, pushedAt: null, problem: null } };
      return { status: 200, body: api.state.settings };
    });
    renderBoard("#/settings");
    expect(await screen.findByText("no push yet")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit the backup remote" }));
    const field = screen.getByRole("textbox", { name: "Backup remote" }) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(screen.getByText(/A password in the remote is hidden here/u)).toBeTruthy();
    await userEvent.type(field, "git@example.com:me/records.git");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(api.sent(/PATCH/u)).toHaveLength(0);
    expect(screen.getByText(/entail will push its records to/u)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Yes, push there" }));
    await waitFor(() => expect(document.getElementById("backup-remote")!.textContent).toBe("git@example.com:me/records.git"));
    expect(api.sent(/PATCH \/api\/settings/u).map((one) => one.body)).toEqual([{ backup: "git@example.com:me/records.git" }]);
  });

  it("says why a command was refused and keeps it open to fix", async () => {
    const api = settingsApi();
    api.fail(/PATCH \/api\/settings/u, { status: 400, body: { error: "start is a command on one line, or null to start nothing" } });
    renderBoard("#/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Edit the starting work command" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Starting work command" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, run it as me" }));
    expect(await screen.findByText("Not saved: start is a command on one line, or null to start nothing.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Starting work command" })).toBeTruthy();
  });

  it("shows a change made from the command line as soon as entail says something changed", async () => {
    vi.stubGlobal("EventSource", FakeEvents);
    const api = settingsApi();
    renderBoard("#/settings");
    expect(await screen.findByText("none", { selector: "#start-command" })).toBeTruthy();
    // `entail settings --start ... --effort high` from a terminal: entail's watcher then emits "changed".
    api.state.settings = { ...api.state.settings, start: "examples/start-to-file.sh", effort: "high" };
    act(() => FakeEvents.last!.onmessage!({ data: JSON.stringify({ type: "changed" }) }));
    await waitFor(() => expect(document.getElementById("start-command")!.textContent).toBe("examples/start-to-file.sh"));
    expect((screen.getByRole("combobox", { name: "Default effort" }) as HTMLSelectElement).value).toBe("high");
    expect(within(document.querySelector(".settings")!).queryByRole("textbox", { name: "Starting work command" })).toBeNull();
  });
});
