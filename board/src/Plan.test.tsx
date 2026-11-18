import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LogPage } from "./api.ts";
import { aCall, aQuestion, aRow, fakeApi, renderBoard } from "./test-support.tsx";

/** A go for planning on the board: its own tag, and plan as a choice next to go and no. */

const PLAN = { call: "go" as const, scope: "plan" as const, reason: "Worth doing, in pieces: it needs a store, a command and a page.", criteria: [] };

describe("A go for planning", () => {
  it("shows as go, for planning with its own tag, and is confirmed as such", async () => {
    const item = aCall({ id: 30, ...PLAN, issue: { number: 199, title: "Team accounts", url: "u", author: "r" } });
    fakeApi({ waiting: { items: [item], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    const chip = await screen.findByText("Go · plan");
    expect(chip.className).toBe("chip c-plan");
    expect(screen.getByText("Go, for planning")).toBeTruthy();
    expect(screen.getByText("Too large for one PR · cleared for planning")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm · go for planning on #199/u })).toBeTruthy();
  });

  it("overrides a go for planning to a go to implement, and a go to a go for planning", async () => {
    const plan = aCall({ id: 31, ...PLAN, issue: { number: 199, title: "Team accounts", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [plan], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    await userEvent.click(await screen.findByRole("button", { name: "Override…" }));
    expect(screen.getAllByRole("radio").map((radio) => radio.parentElement!.textContent)).toEqual(["No, close it", "Go to implement instead", "Go, but differently"]);
    await userEvent.click(screen.getByRole("radio", { name: "Go to implement instead" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your reason" }), "It fits one PR.{Enter}");
    const receipt = await screen.findByRole("article", { name: "Overridden. #199" });
    expect(within(receipt).getByText(/Go instead\./u)).toBeTruthy();
    expect(api.sent(/override/u).at(-1)!.body).toEqual({ call: "go", reason: "It fits one PR." });
  });

  it("offers a go for planning next to no and go made differently when overriding a go", async () => {
    const go = aCall({ id: 32, call: "go", reason: "Fine.", issue: { number: 200, title: "Big", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [go], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    await userEvent.click(await screen.findByRole("button", { name: "Override…" }));
    await userEvent.click(screen.getByRole("radio", { name: "Go, for planning" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your reason" }), "Plan it into tickets.{Enter}");
    const receipt = await screen.findByRole("article", { name: "Overridden. #200" });
    expect(within(receipt).getByText(/Go, for planning\. It goes on the issue and into the case book\./u)).toBeTruthy();
    expect(within(receipt).getByText("Go · plan")).toBeTruthy();
    expect(api.sent(/override/u).at(-1)!.body).toEqual({ call: "plan", reason: "Plan it into tickets." });
  });

  it("answers a question with go for planning as a third choice", async () => {
    const question = aQuestion({ id: 33, issue: { number: 11, title: "Move the log", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [question], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    await screen.findByRole("button", { name: "Answer" });
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["go", "plan", "no"]);
    await userEvent.click(screen.getByRole("radio", { name: /Go, for planning/u }));
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    const receipt = await screen.findByRole("article", { name: "Answered. #11" });
    expect(within(receipt).getByText(/posts the go for planning on #11/u)).toBeTruthy();
    expect(api.sent(/answer/u)[0]!.body).toEqual({ call: "plan", answer: "Go, for planning." });
  });

  it("tags a go for planning in the log, and the owner's override to plan", async () => {
    const plan = aCall({ id: 34, ...PLAN, status: "auto", issue: { number: 199, title: "Team accounts", url: "u", author: "r" } });
    const overridden = aCall({
      id: 35,
      call: "no",
      status: "overridden",
      issue: { number: 201, title: "Workspaces", url: "u", author: "r" },
      settledBy: { id: 36, type: "overridden", at: new Date().toISOString(), by: "Omkar", call: 35, to: "go", scope: "plan", reason: "Plan it." },
    });
    const page: LogPage = { rows: [aRow(plan), aRow(overridden)], suggestions: [], next: null, counts: { all: 2, waiting: 0, overridden: 1, questions: 0, prs: 0 } };
    fakeApi({ log: () => page });
    renderBoard("#/log");
    const row = (await screen.findByText("Team accounts")).closest("li")!;
    expect(within(row).getByText("Go · plan")).toBeTruthy();
    const other = screen.getByText("Workspaces").closest("li")!;
    expect(within(other).getByText("Go · plan")).toBeTruthy();
    expect(within(other).getByText("No")).toBeTruthy();
  });
});
