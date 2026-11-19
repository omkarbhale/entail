import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { aRepo, fakeApi, renderBoard } from "./test-support.tsx";

describe("Repos", () => {
  it("shows each repo with its settings, where the settings for every repo are, and the nudge to turn confirm mode off", async () => {
    fakeApi({
      repos: [aRepo({ checked: 6, agreed: 5, suggestConfirmOff: true, pins: { file: "/data/pins/github.com/omkarbhale/entail.md", topics: ["pricing", "the board's look"] } })],
    });
    renderBoard("#/repos");
    expect(await screen.findByRole("heading", { name: "Repos" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Default model" })).toBeNull();
    expect(within(document.querySelector("main")!).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("#/settings");
    expect(screen.getByText(/You’ve checked 6 of its calls here and agreed with 5\./u)).toBeTruthy();
    expect(screen.getByText("It agrees with you often enough to try confirm mode off.")).toBeTruthy();
    expect(screen.getByText("pricing · the board's look")).toBeTruthy();
    expect(screen.getByRole("link", { name: /VISION\.md at 8973851/u })).toBeTruthy();
    expect(screen.getByText(/^watching · checked 4\ds ago$/u)).toBeTruthy();
  });

  it("says once on the repo's card why entail cannot label its issues", async () => {
    fakeApi({ repos: [aRepo({ cannotLabel: "the logged-in account has read access only; adding labels needs triage access or more" })] });
    renderBoard("#/repos");
    expect(await screen.findByText("entail cannot label issues here:")).toBeTruthy();
    expect(screen.getByText(/read access only; adding labels needs triage access or more\. Calls still post and close/u)).toBeTruthy();
  });

  it("lists on the repo's card each issue held on its open blockers", async () => {
    fakeApi({ repos: [aRepo({ blocked: [{ issue: 5, url: "https://github.com/omkarbhale/entail/issues/5", title: "Export per-chapter counts", blockers: ["#3", "acme/core#9"], since: "2026-11-12T10:00:00.000Z" }] })] });
    renderBoard("#/repos");
    expect((await screen.findByRole("link", { name: "#5" })).getAttribute("href")).toBe("https://github.com/omkarbhale/entail/issues/5");
    expect(screen.getByText(/waits on #3, acme\/core#9; no call until they close\./u)).toBeTruthy();
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

  it("sets a repo's base branch, and clears it back to the forge's default branch", async () => {
    const api = fakeApi();
    api.route((method, path, body) => {
      if (method === "PATCH" && path === "/api/repos/omkarbhale/entail") {
        api.state.repos = [aRepo({ baseBranch: body.baseBranch })];
        return { status: 200, body: {} };
      }
      return undefined;
    });
    renderBoard("#/repos");
    const field = await screen.findByRole("textbox", { name: "Base branch" });
    expect(field.getAttribute("placeholder")).toBe("GitHub’s default branch");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await userEvent.type(field, " develop ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.sent(/PATCH/u)[0]!.body).toEqual({ baseBranch: "develop" });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Base branch" }) as HTMLInputElement).value).toBe("develop"));
    await userEvent.clear(screen.getByRole("textbox", { name: "Base branch" }));
    await userEvent.click(screen.getByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(api.sent(/PATCH/u)[1]!.body).toEqual({ baseBranch: null }));
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
    expect(screen.getByText("Use owner/repo, for example omkarbhale/entail, gitlab:group/repo for a GitLab project, or gitlab://host/group/repo on a self-hosted GitLab.")).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, "https://git.example.com/acme/tally");
    await userEvent.click(screen.getByRole("button", { name: "Enroll" }));
    expect(screen.getByText("Use owner/repo, for example omkarbhale/entail, or gitlab:group/repo for a GitLab project. For a self-hosted GitLab, put gitlab: before its address.")).toBeTruthy();
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

  it("enrolls a GitLab project from its gitlab.com address, links its card to GitLab and reaches it by its whole name", async () => {
    const api = fakeApi({ repos: [] });
    api.route((method, path, body) => {
      if (method === "POST" && path === "/api/repos") {
        const repo = aRepo({ repo: body.repo, calls: 0, waiting: 0, checked: 0, agreed: 0, vision: null, checkedAt: null });
        api.state.repos = [...api.state.repos, repo];
        return { status: 201, body: { repo, openIssues: 0 } };
      }
      if (method === "POST" && path.endsWith("/check")) return { status: 200, body: { repo: "gitlab:acme/tools/tally", at: new Date().toISOString(), judged: 0, posted: 2, failed: false } };
      return undefined;
    });
    renderBoard("#/repos");
    const field = await screen.findByRole("textbox", { name: "Repo to enroll" });
    await userEvent.type(field, "https://gitlab.com/acme/tools/tally");
    const release = api.hold(/POST \/api\/repos$/u);
    await userEvent.click(screen.getByRole("button", { name: "Enroll" }));
    expect(await screen.findByRole("button", { name: "Checking access on GitLab…" })).toBeTruthy();
    release();
    const link = await screen.findByRole("link", { name: /gitlab:acme\/tools\/tally/u });
    expect(link.getAttribute("href")).toBe("https://gitlab.com/acme/tools/tally");
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Checked just now: 2 posts on GitLab.")).toBeTruthy();
    expect(api.sent(/POST \/api\/repos\/gitlab%3Aacme%2Ftools%2Ftally\/check/u)).toHaveLength(1);
  });

  it("enrolls a project on a self-hosted GitLab from gitlab: and its address, links its card to that host and reaches it by its whole name", async () => {
    const api = fakeApi({ repos: [] });
    api.route((method, path, body) => {
      if (method === "POST" && path === "/api/repos") {
        const repo = aRepo({ repo: body.repo, calls: 0, waiting: 0, checked: 0, agreed: 0, vision: null, checkedAt: null });
        api.state.repos = [...api.state.repos, repo];
        return { status: 201, body: { repo, openIssues: 0 } };
      }
      if (method === "POST" && path.endsWith("/check")) return { status: 200, body: { repo: "gitlab://git.example.com/acme/tally", at: new Date().toISOString(), judged: 0, posted: 1, failed: false } };
      return undefined;
    });
    renderBoard("#/repos");
    const field = await screen.findByRole("textbox", { name: "Repo to enroll" });
    await userEvent.type(field, "gitlab:https://git.example.com/acme/tally/-/issues");
    const release = api.hold(/POST \/api\/repos$/u);
    await userEvent.click(screen.getByRole("button", { name: "Enroll" }));
    expect(await screen.findByRole("button", { name: "Checking access on GitLab…" })).toBeTruthy();
    release();
    const link = await screen.findByRole("link", { name: /gitlab:\/\/git\.example\.com\/acme\/tally/u });
    expect(link.getAttribute("href")).toBe("https://git.example.com/acme/tally");
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Checked just now: 1 post on GitLab.")).toBeTruthy();
    expect(api.sent(/POST \/api\/repos\/gitlab%3A%2F%2Fgit\.example\.com%2Facme%2Ftally\/check/u)).toHaveLength(1);
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

  it("suggests work with the model and effort picked, shows the run in flight, and says when one is already running", async () => {
    const api = fakeApi({ repos: [aRepo({ uses: { model: "claude-sonnet-5-5", effort: "high" } })] });
    api.route((method, path, body) => {
      if (method === "POST" && path === "/api/repos/omkarbhale/entail/suggest") {
        api.state.repos = [aRepo({ suggesting: { state: "running", since: new Date().toISOString(), model: body.model, effort: body.effort, resuming: false } })];
        return { status: 202, body: { repo: "omkarbhale/entail", since: new Date().toISOString(), ...body } };
      }
      return undefined;
    });
    renderBoard("#/repos");
    const model = (await screen.findByRole("combobox", { name: "Model to suggest work for omkarbhale/entail with" })) as HTMLSelectElement;
    expect(model.value).toBe("claude-sonnet-5-5");
    expect((screen.getByRole("combobox", { name: "Effort to suggest work for omkarbhale/entail with" }) as HTMLSelectElement).value).toBe("high");
    await userEvent.selectOptions(model, "claude-opus-5-5");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Effort to suggest work for omkarbhale/entail with" }), "max");
    await userEvent.click(screen.getByRole("button", { name: "Suggest work" }));
    expect(await screen.findByText(/Suggesting, started just now with claude-opus-5-5 at max effort…/u)).toBeTruthy();
    expect(api.sent(/POST \/api\/repos\/omkarbhale\/entail\/suggest/u)[0]!.body).toEqual({ model: "claude-opus-5-5", effort: "max" });
    expect((screen.getByRole("button", { name: "Suggesting…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows how the last run ended, and the refusal when a run is already going", async () => {
    const api = fakeApi({ repos: [aRepo({ suggesting: { state: "done", at: new Date().toISOString(), run: 9, suggested: 3, filed: 3 } })] });
    api.fail(/suggest/u, { status: 409, body: { error: "entail is already suggesting work for omkarbhale/entail; wait for that run to finish" } });
    renderBoard("#/repos");
    expect(await screen.findByText(/Last run just now: 3 suggestions, all filed as issues\./u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the run in the log" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Suggest work" }));
    expect(await screen.findByText(/Not started: entail is already suggesting work for omkarbhale\/entail; wait for that run to finish\./u)).toBeTruthy();
  });

  it("says why the last run failed", async () => {
    fakeApi({ repos: [aRepo({ suggesting: { state: "failed", at: new Date().toISOString(), reason: "the run gave no suggestions (timeout): ended after 60 minutes" } })] });
    renderBoard("#/repos");
    expect(await screen.findByText(/Last run just now failed: the run gave no suggestions \(timeout\)/u)).toBeTruthy();
  });
});
