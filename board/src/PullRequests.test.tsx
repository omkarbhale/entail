import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { aPullRequestCall, aQuestion, fakeApi, renderBoard } from "./test-support.tsx";

const empty = { count: 0, repos: [] };

describe("a PR's card", () => {
  it("names the PR and the issue it closes, with the merge chip and a confirm button that says what it does", async () => {
    const item = aPullRequestCall({ id: 31, issue: { number: 174, title: "Count words", url: "https://github.com/omkarbhale/entail/issues/174", author: "r" } });
    fakeApi({ waiting: { items: [item], held: [], actedAlone: empty } });
    renderBoard();
    expect(await screen.findByRole("heading", { level: 3, name: "Fix for 174" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #1174 ↗" }).getAttribute("href")).toBe("https://github.com/omkarbhale/entail/pull/1174");
    expect(screen.getByText("closes", { exact: false }).textContent).toContain("#174");
    expect(document.querySelector(".chip.c-merge")?.textContent).toBe("Merge");
    expect(screen.getByRole("button", { name: "Confirm · merge #1174" })).toBeTruthy();
  });

  it("shows the criteria as a met and unmet checklist with the evidence, and counts them", async () => {
    fakeApi({ waiting: { items: [aPullRequestCall({ id: 32 })], held: [], actedAlone: empty } });
    renderBoard();
    expect(await screen.findByText("Criteria · 1 of 2 met")).toBeTruthy();
    const items = screen.getAllByRole("listitem").filter((li) => li.closest(".checklist"));
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByLabelText("met")).toBeTruthy();
    expect(within(items[0]!).getByText("src/count.ts:12")).toBeTruthy();
    expect(within(items[1]!).getByLabelText("not met")).toBeTruthy();
    expect(within(items[1]!).getByText("It also prints a header.")).toBeTruthy();
  });

  it("has a line from GitHub, not from the PR, with CI and whether VISION.md was touched", async () => {
    const item = aPullRequestCall({ id: 33 });
    item.pr!.facts.touched = { vision: true, pins: [] };
    item.pr!.facts.checks = [
      { name: "test", status: "failed", reported: true, url: null },
      { name: "lint", status: "passed", reported: true, url: null },
    ];
    fakeApi({ waiting: { items: [item], held: [], actedAlone: empty } });
    renderBoard();
    const line = (await screen.findByText("From GitHub, not from the PR")).closest("p")!;
    expect(line.textContent).toContain("CI: 1 of 2 checks failed");
    expect(line.textContent).toContain("VISION.md is changed");
  });

  it("collapses what the PR does beyond its criteria, sorted, and shows nothing when there is none", async () => {
    const withBeyond = aPullRequestCall({ id: 34 });
    const without = aPullRequestCall({ id: 35, issue: { number: 300, title: "Other", url: "u", author: "r" } });
    without.pr!.beyond = [];
    fakeApi({ waiting: { items: [withBeyond, without], held: [], actedAlone: empty } });
    renderBoard();
    await screen.findByText("Criteria · 1 of 2 met", { selector: "span", exact: true }).catch(() => null);
    const summaries = await screen.findAllByText("Beyond the criteria · 0 needed · 1 harmless · 1 unwanted");
    expect(summaries).toHaveLength(1);
    const details = summaries[0]!.closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(within(details).getByText(/Adds a flag/u)).toBeTruthy();
    expect(screen.queryAllByText(/^Beyond the criteria/u)).toHaveLength(1);
  });

  it("confirms a send-back with its own label, and overriding a merge offers only sending it back, with a required reason", async () => {
    const back = aPullRequestCall({ id: 36, call: "send-back", reason: "A criterion is unmet.", issue: { number: 50, title: "Count", url: "u", author: "r" } });
    back.pr!.needsToChange = ["Remove the header"];
    const merge = aPullRequestCall({ id: 37, issue: { number: 60, title: "Other", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [back, merge], held: [], actedAlone: empty } });
    renderBoard();
    expect(await screen.findByRole("button", { name: "Confirm · send back #1050" })).toBeTruthy();
    expect(screen.getByText("Remove the header")).toBeTruthy();
    expect(document.querySelector(".chip.c-send-back")?.textContent).toBe("Send back");

    const overrides = screen.getAllByRole("button", { name: "Override…" });
    await userEvent.click(overrides[1]!);
    const form = document.querySelector("form.ov") as HTMLElement;
    expect(within(form).getByText("Send it back")).toBeTruthy();
    expect(within(form).queryByRole("radio")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(screen.getByRole("alert").textContent).toBe("Say why in a line: it goes on the PR and into the case book.");
    await userEvent.type(screen.getByRole("textbox", { name: "Your reason" }), "Not for this release{Enter}");
    const receipt = await screen.findByRole("article", { name: "Overridden. #1060" });
    expect(within(receipt).getByText(/Send it back\. It goes on the PR and into the case book\./u)).toBeTruthy();
    expect(api.sent(/POST \/api\/calls\/37\/override/u)[0]!.body).toEqual({ call: "send-back", reason: "Not for this release" });
  });

  it("answers a PR's question by choosing merge or send back", async () => {
    const question = aPullRequestCall({
      id: 38,
      call: "ask",
      question: { question: "Is the flag acceptable?", why: "It adds surface.", large: false },
    });
    const api = fakeApi({ waiting: { items: [question], held: [], actedAlone: empty } });
    renderBoard();
    expect(await screen.findByRole("radio", { name: /Merge it/u })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Go ahead/u })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /Send it back/u }));
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    const receipt = await screen.findByRole("article", { name: /Answered\./u });
    expect(within(receipt).getByText(/Send it back\./u)).toBeTruthy();
    expect(api.sent(/answer/u)[0]!.body).toEqual({ call: "send-back", answer: "Send it back." });
  });

  it("leaves an issue's question and its Go chip as they were", async () => {
    fakeApi({ waiting: { items: [aQuestion({ id: 39 })], held: [], actedAlone: empty } });
    renderBoard();
    expect(await screen.findByRole("radio", { name: /Go ahead/u })).toBeTruthy();
    expect(document.querySelector(".c-merge")).toBeNull();
  });
});
