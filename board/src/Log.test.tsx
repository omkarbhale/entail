import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LogPage } from "./api.ts";
import { localDay } from "./format.ts";
import { aCall, aPullRequestCall, aQuestion, aRow, fakeApi, renderBoard } from "./test-support.tsx";

const today = new Date();
today.setHours(10, 0, 0, 0);
const at = (daysAgo: number, hour = 10) => {
  const date = new Date(today);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour);
  return date.toISOString();
};
const dayOf = (daysAgo: number) => localDay(new Date(at(daysAgo)));
const counts = { all: 4, waiting: 1, overridden: 1, questions: 1, prs: 0 };

describe("Log", () => {
  it("shows the calls newest first, grouped by day, with entail's call and the owner's kept side by side", async () => {
    const overridden = aCall({
      id: 1,
      call: "go",
      status: "overridden",
      judgedAt: at(1, 13),
      reason: "Update the board in place; keep it server-rendered.",
      issue: { number: 169, title: "The board should be good", url: "u169", author: "r" },
      settledBy: { id: 11, type: "overridden", at: at(1, 14), by: "Omkar", call: 1, to: "go", reason: "Rebuild it as a single-page app.", differently: true },
    });
    const waiting = aQuestion({ id: 2, judgedAt: at(0, 9), issue: { number: 11, title: "Non-breaking spaces", url: "u11", author: "r" } });
    const page: LogPage = {
      rows: [
        aRow(waiting, { day: dayOf(0) }),
        aRow(overridden, {
          day: dayOf(1),
          trail: [
            { at: at(1, 13), text: "Judged: go · claude-opus-5-5, low" },
            { at: at(1, 14), text: "Omkar overrode: go, differently" },
            { at: at(1, 14), text: "Added to the case book; posted on the issue", url: "https://github.com/x" },
          ],
        }),
      ],
      next: null,
      counts,
    };
    const api = fakeApi({ log: () => page });
    const release = api.hold(/GET \/api\/log/u);
    renderBoard("#/log");
    expect(await screen.findByText("Loading…")).toBeTruthy();
    release();
    expect(await screen.findByRole("heading", { name: "Log" })).toBeTruthy();
    expect(screen.getByText(/4 calls · 1 waiting on you · you overrode 1/u)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Made differently by Omkar")).toBeTruthy();

    const row = screen.getByRole("button", { name: /The board should be good/u });
    await userEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = row.parentElement!;
    expect(within(detail).getByText("Update the board in place; keep it server-rendered.", { selector: ".reason" })).toBeTruthy();
    expect(within(detail).getByText("Go, made differently by Omkar")).toBeTruthy();
    expect(within(detail).getByText("Rebuild it as a single-page app.")).toBeTruthy();
    expect(within(detail).getByText("Omkar overrode: go, differently")).toBeTruthy();
    expect(within(detail).getByRole("link", { name: "Open issue on GitHub ↗" }).getAttribute("href")).toBe("u169");
    expect(api.sent(/GET \/api\/log/u)[0]).toBeTruthy();
  });

  it("filters, and pages back by day without trimming anything", async () => {
    const recent = aCall({ id: 5, status: "auto", judgedAt: at(0), issue: { number: 5, title: "Recent", url: "u", author: "r" } });
    const old = aCall({ id: 6, status: "auto", judgedAt: at(9), issue: { number: 6, title: "Old", url: "u", author: "r" } });
    const api = fakeApi({
      log: (query) =>
        query.get("before") === null
          ? { rows: [aRow(recent, { day: dayOf(0) })], next: dayOf(0), counts }
          : { rows: [aRow(old, { day: dayOf(9) })], next: null, counts },
    });
    renderBoard("#/log");
    expect(await screen.findByText("Recent")).toBeTruthy();
    const release = api.hold(/GET \/api\/log/u);
    await userEvent.click(screen.getByRole("button", { name: "Earlier days" }));
    expect(await screen.findByRole("button", { name: "Reading earlier days…" })).toBeTruthy();
    release();
    expect(await screen.findByText("Old")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Earlier days" })).toBeNull();
    expect(api.sent(/GET \/api\/log/u).length).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole("button", { name: /Overridden/u }));
    await waitFor(() => expect(api.requests.some((one) => one.path === "/api/log")).toBe(true));
    expect(screen.getByRole("button", { name: /Overridden/u }).getAttribute("aria-pressed")).toBe("true");
  });

  it("overrides a call entail acted on at once from its row, with the same one-line form and Undo", async () => {
    const auto = aCall({ id: 31, status: "auto", confirmMode: false, judgedAt: at(0), issue: { number: 7, title: "Read flags from ~/.tallyrc", url: "u", author: "r" } });
    const api = fakeApi({ log: () => ({ rows: [aRow(auto, { day: dayOf(0) })], next: null, counts }) });
    api.route((method, path, body) =>
      method === "POST" && path === "/api/calls/31/override"
        ? { status: 200, body: { id: 99, type: "overridden", at: new Date().toISOString(), by: "Omkar", call: 31, to: body.call, reason: body.reason, holdUntil: new Date(Date.now() + 10_000).toISOString() } }
        : undefined,
    );
    renderBoard("#/log");
    await userEvent.click(await screen.findByRole("button", { name: /Read flags from/u }));
    await userEvent.click(screen.getByRole("button", { name: "Override this call…" }));
    expect(screen.getByText("Go instead")).toBeTruthy();
    await userEvent.type(screen.getByRole("textbox", { name: "Your reason" }), "Config files are fine for flags.{Enter}");
    expect(await screen.findByRole("article", { name: "Overridden. #7" })).toBeTruthy();
    expect(api.sent(/POST \/api\/calls\/31\/override/u)[0]!.body).toEqual({ call: "go", reason: "Config files are fine for flags." });
  });

  it("shows a PR's call with its own chip, status and link, and filters to PRs", async () => {
    const merged = aPullRequestCall({ id: 41, status: "confirmed", judgedAt: at(0), settledBy: { id: 50, type: "confirmed", at: at(0), by: "Omkar", call: 41 }, issue: { number: 8, title: "Count words", url: "u8", author: "r" } });
    const filters: (string | null)[] = [];
    fakeApi({
      log: (query) => {
        filters.push(query.get("filter"));
        return { rows: [aRow(merged, { day: dayOf(0), trail: [{ at: at(0), text: "Judged PR #1008: merge · claude-opus-5-5, low" }] })], next: null, counts: { ...counts, prs: 1 } };
      },
    });
    renderBoard("#/log");
    const row = await screen.findByRole("button", { name: /Fix for 8/u });
    expect(within(row).getByText("PR #1008", { exact: false })).toBeTruthy();
    expect(within(row).getByText("Merge")).toBeTruthy();
    expect(within(row).getByText("Confirmed by Omkar")).toBeTruthy();
    await userEvent.click(row);
    expect(screen.getByRole("link", { name: "Open PR on GitHub ↗" }).getAttribute("href")).toBe("https://github.com/omkarbhale/entail/pull/1008");
    await userEvent.click(screen.getByRole("button", { name: /^PRs/u }));
    await waitFor(() => expect(filters).toContain("prs"));
  });

  it("says when there is nothing yet, and when entail cannot be read", async () => {
    const api = fakeApi();
    const { unmount } = renderBoard("#/log");
    expect(await screen.findByText(/Nothing yet/u)).toBeTruthy();
    unmount();
    api.fail(/GET \/api\/log/u, "network", false);
    renderBoard("#/log");
    expect(await screen.findByRole("heading", { name: "entail did not answer." })).toBeTruthy();
  });
});
