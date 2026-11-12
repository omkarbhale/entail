import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { aRepo, fakeApi, renderBoard } from "./test-support.tsx";

describe("Repos", () => {
  it("shows each repo with its settings, the default model, and the nudge to turn confirm mode off", async () => {
    fakeApi({
      repos: [aRepo({ checked: 6, agreed: 5, suggestConfirmOff: true, pins: { file: "/data/pins/github.com/omkarbhale/entail.md", topics: ["pricing", "the board's look"] } })],
    });
    renderBoard("#/repos");
    expect(await screen.findByRole("heading", { name: "Repos" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement).value).toBe("claude-opus-5-5");
    expect((screen.getByRole("combobox", { name: "Default effort" }) as HTMLSelectElement).value).toBe("low");
    expect(screen.getByText(/You’ve checked 6 of its calls here and agreed with 5\./u)).toBeTruthy();
    expect(screen.getByText("It agrees with you often enough to try confirm mode off.")).toBeTruthy();
    expect(screen.getByText("pricing · the board's look")).toBeTruthy();
    expect(screen.getByRole("link", { name: /VISION\.md at 8973851/u })).toBeTruthy();
    expect(screen.getByText(/^watching · checked 4\ds ago$/u)).toBeTruthy();
  });

  it("switches confirm mode with a pending state and Saved, and says what keeps waiting", async () => {
    const api = fakeApi();
    api.route((method, path, body) => {
      if (method === "PATCH" && path === "/api/repos/omkarbhale/entail") {
        api.state.repos = [aRepo({ confirm: body.confirm })];
        return { status: 200, body: {} };
      }
      return undefined;
    });
    renderBoard("#/repos");
    const toggle = await screen.findByRole("switch", { name: "Confirm mode for omkarbhale/entail" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const release = api.hold(/PATCH/u);
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    release();
    expect(await screen.findByText("Saved")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("What is already waiting still waits for you; new calls act at once.")).toBeTruthy();
    expect(api.sent(/PATCH/u)[0]!.body).toEqual({ confirm: false });
  });

  it("checks a repo now and says what the check found, or that it failed", async () => {
    const api = fakeApi();
    api.route((method, path) => (method === "POST" && path.endsWith("/check") ? { status: 200, body: { repo: "omkarbhale/entail", at: new Date().toISOString(), judged: 0, posted: 0, failed: false } } : undefined));
    renderBoard("#/repos");
    const release = api.hold(/check/u);
    await userEvent.click(await screen.findByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeTruthy();
    release();
    expect(await screen.findByText("Checked just now: no new or edited issues.")).toBeTruthy();
    api.fail(/check/u, "network");
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("entail did not answer. Nothing changed; try again.")).toBeTruthy();
  });

  it("enrolls a repo after checking its name, and then offers the open backlog as a separate click", async () => {
    const api = fakeApi();
    api.route((method, path, body) => {
      if (method === "POST" && path === "/api/repos") {
        const repo = aRepo({ repo: body.repo, calls: 0, waiting: 0, checked: 0, agreed: 0, vision: null, checkedAt: null });
        api.state.repos = [...api.state.repos, repo];
        return { status: 201, body: { repo, openIssues: 23 } };
      }
      if (method === "POST" && path.endsWith("/backlog")) {
        api.state.repos = api.state.repos.map((one) => (one.repo === "acme/tally" ? { ...one, backlogAsked: true } : one));
        return { status: 200, body: { repo: "acme/tally", issues: [1, 2] } };
      }
      return undefined;
    });
    renderBoard("#/repos");
    const field = await screen.findByRole("textbox", { name: "Repo to enroll" });
    await userEvent.type(field, "not a repo");
    await userEvent.click(screen.getByRole("button", { name: "Enroll" }));
    expect(screen.getByText("Use owner/repo, for example omkarbhale/entail.")).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, "acme/tally");
    const release = api.hold(/POST \/api\/repos$/u);
    await userEvent.click(screen.getByRole("button", { name: "Enroll" }));
    expect(await screen.findByRole("button", { name: "Checking access on GitHub…" })).toBeTruthy();
    release();
    const offer = await screen.findByRole("button", { name: "Also judge the 23 open ones" });
    expect(screen.getByText(/23 open issues are already there; entail judges new and edited issues from now on\./u)).toBeTruthy();
    await userEvent.click(offer);
    expect(await screen.findByText(/entail is judging the open backlog/u)).toBeTruthy();
    expect(api.sent(/POST \/api\/repos\/acme\/tally\/backlog/u)).toHaveLength(1);
  });

  it("asks before unenrolling, saying what happens to what waits", async () => {
    const api = fakeApi();
    api.route((method) => {
      if (method === "DELETE") {
        api.state.repos = [];
        return { status: 200, body: {} };
      }
      return undefined;
    });
    renderBoard("#/repos");
    await userEvent.click(await screen.findByRole("button", { name: "Unenroll…" }));
    expect(screen.getByText(/Stop watching omkarbhale\/entail\? Its 2 waiting items are withdrawn and nothing more is posted\. The log keeps its calls\./u)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await userEvent.click(screen.getByRole("button", { name: "Unenroll…" }));
    await userEvent.click(screen.getByRole("button", { name: "Unenroll" }));
    expect(await screen.findByRole("heading", { name: "entail isn’t watching any repo yet" })).toBeTruthy();
    expect(api.sent(/DELETE/u)).toHaveLength(1);
  });

  it("saves the notice command, the one setting for how the owner hears something is waiting", async () => {
    const api = fakeApi();
    api.route((method, path, body) => {
      if (method === "PATCH" && path === "/api/settings") {
        api.state.settings = { ...api.state.settings, ...body };
        return { status: 200, body: api.state.settings };
      }
      return undefined;
    });
    renderBoard("#/repos");
    const field = await screen.findByRole("textbox", { name: /Notices\./u });
    await userEvent.type(field, "examples/notice-to-firstmate.sh");
    const form = field.closest("form")!;
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText("Saved")).toBeTruthy();
    expect(api.sent(/PATCH \/api\/settings/u)[0]!.body).toEqual({ notice: "examples/notice-to-firstmate.sh" });
  });
});
