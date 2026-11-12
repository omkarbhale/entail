import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { aCall, aQuestion, aRepo, fakeApi, held, renderBoard } from "./test-support.tsx";

describe("Waiting", () => {
  it("shows skeleton cards while entail is read, then questions first and calls to confirm oldest first, with the count in the tab title", async () => {
    const older = aCall({ id: 1, waitingSince: "2026-11-10T09:00:00.000Z", issue: { number: 174, title: "Make the board glittery", url: "u174", author: "r" } });
    const newer = aCall({ id: 2, call: "go", waitingSince: "2026-11-11T09:00:00.000Z", issue: { number: 177, title: "Landing check refuses consequences", url: "u177", author: "r" } });
    const question = aQuestion({ id: 3, waitingSince: "2026-11-12T08:00:00.000Z", issue: { number: 11, title: "Non-breaking spaces", url: "u11", author: "r" } });
    const api = fakeApi({ waiting: { items: [question, older, newer], held: [], actedAlone: { count: 0, repos: [] } } });
    const release = api.hold(/GET \/api\/waiting/u);
    renderBoard();
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(document.querySelectorAll(".sk").length).toBe(3);
    release();
    expect(await screen.findByRole("heading", { name: "3 waiting on you" })).toBeTruthy();
    expect(screen.getByText("1 question · 2 calls to confirm")).toBeTruthy();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(titles).toEqual(["Non-breaking spaces", "Make the board glittery", "Landing check refuses consequences"]);
    expect(document.title).toBe("(3) entail");
    expect(screen.getByRole("button", { name: "Confirm · close #174" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm · go on #177" })).toBeTruthy();
    expect(screen.getAllByText("“Its value over chat is structure.”".slice(1, -1)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /VISION\.md:48 at 8973851/u }).length).toBe(3);
  });

  it("welcomes an owner with no repo enrolled, and says plainly when nothing is waiting", async () => {
    const api = fakeApi({ repos: [] });
    const { unmount } = renderBoard();
    expect(await screen.findByRole("heading", { name: "entail isn’t watching any repo yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enroll" })).toBeTruthy();
    unmount();
    api.state.repos = [aRepo()];
    api.state.waiting = { items: [], held: [], actedAlone: { count: 7, repos: ["omkarbhale/tally"] } };
    renderBoard();
    expect(await screen.findByRole("heading", { name: "Nothing is waiting on you." })).toBeTruthy();
    expect(screen.getByText(/entail made 7 calls on its own in tally, where confirm mode is off/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read them in the log" }).getAttribute("href")).toBe("#/log");
    expect(document.title).toBe("entail");
  });

  it("confirms in place: the button says what it is doing, the card becomes a receipt with Undo, and Undo brings it back", async () => {
    const item = aCall({ id: 7, issue: { number: 174, title: "Make the board glittery", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [item], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    const confirm = await screen.findByRole("button", { name: "Confirm · close #174" });
    const release = api.hold(/POST \/api\/calls\/7\/confirm/u);
    await userEvent.click(confirm);
    expect(await screen.findByRole("button", { name: "Confirming…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Override…" }).hasAttribute("disabled")).toBe(true);
    release();
    const receipt = await screen.findByRole("article", { name: "Confirmed. #174" });
    expect(within(receipt).getByText(/entail closes #174 with its reason\./u)).toBeTruthy();
    expect(within(receipt).getByRole("button", { name: /Undo 1?\ds/u })).toBeTruthy();
    expect(api.sent(/POST \/api\/calls\/7\/confirm/u)).toHaveLength(1);
    await waitFor(() => expect(document.title).toBe("entail"));

    await userEvent.click(within(receipt).getByRole("button", { name: /Undo/u }));
    expect(await screen.findByRole("button", { name: "Confirm · close #174" })).toBeTruthy();
    expect(screen.getByText("Undone. Nothing was sent to GitHub.")).toBeTruthy();
    expect(api.sent(/POST \/api\/calls\/7\/undo/u)).toHaveLength(1);
  });

  it("when entail does not answer, says nothing was recorded or sent, and lets the owner try again", async () => {
    const item = aCall({ id: 8, issue: { number: 174, title: "Glitter", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [item], held: [], actedAlone: { count: 0, repos: [] } } });
    api.fail(/POST \/api\/calls\/8\/confirm/u, "network");
    renderBoard();
    await userEvent.click(await screen.findByRole("button", { name: "Confirm · close #174" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/entail did not answer, so nothing was recorded and nothing was sent to GitHub\. Try again\./u);
    await userEvent.click(screen.getByRole("button", { name: "Confirm · close #174" }));
    expect(await screen.findByRole("article", { name: "Confirmed. #174" })).toBeTruthy();
  });

  it("overrides with a one-line reason that is required and kept through a failure; a go can be made differently", async () => {
    const item = aCall({ id: 9, call: "go", issue: { number: 169, title: "The board should be good", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [item], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    await userEvent.click(await screen.findByRole("button", { name: "Override…" }));
    const reason = screen.getByRole("textbox", { name: "Your reason" });
    expect(document.activeElement).toBe(reason);
    expect(screen.getByRole("radio", { name: "No, close it" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(screen.getByRole("alert").textContent).toBe("Say why in a line: it goes on the issue and into the case book.");
    expect(api.sent(/override/u)).toHaveLength(0);

    await userEvent.click(screen.getByRole("radio", { name: "Go, but differently" }));
    const line = screen.getByRole("textbox", { name: "What should be different" });
    await userEvent.type(line, "Rebuild it as a single-page app");
    api.fail(/POST \/api\/calls\/9\/override/u, "network");
    await userEvent.type(line, "{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/nothing was recorded/u);
    expect((screen.getByRole("textbox", { name: "What should be different" }) as HTMLInputElement).value).toBe("Rebuild it as a single-page app");

    await userEvent.click(screen.getByRole("button", { name: "Override" }));
    const receipt = await screen.findByRole("article", { name: "Overridden. #169" });
    expect(within(receipt).getByText(/Go, but differently\. It goes on the issue and into the case book\./u)).toBeTruthy();
    expect(within(receipt).getByText("Rebuild it as a single-page app")).toBeTruthy();
    expect(api.sent(/POST \/api\/calls\/9\/override/u).at(-1)!.body).toEqual({ call: "go", reason: "Rebuild it as a single-page app", differently: true });

    // Undoing an override opens the form again with the words kept.
    await userEvent.click(within(receipt).getByRole("button", { name: /Undo/u }));
    expect(((await screen.findByRole("textbox", { name: "What should be different" })) as HTMLInputElement).value).toBe("Rebuild it as a single-page app");
  });

  it("answers a question with one pick and an optional note, and the button waits for a pick", async () => {
    const question = aQuestion({ id: 10, issue: { number: 11, title: "Non-breaking spaces", url: "u", author: "r" } });
    const api = fakeApi({ waiting: { items: [question], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    const answer = await screen.findByRole("button", { name: "Answer" });
    expect(answer.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Should a non-breaking space separate two words?")).toBeTruthy();
    expect(screen.getByText("“10 km” counts as 2 words one way and 1 the other.")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /Don’t go ahead/u }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer in your own words" }), "Only real whitespace separates words.");
    const release = api.hold(/POST \/api\/calls\/10\/answer/u);
    await userEvent.click(answer);
    expect(await screen.findByRole("button", { name: "Recording your answer…" })).toBeTruthy();
    release();
    const receipt = await screen.findByRole("article", { name: "Answered. #11" });
    expect(within(receipt).getByText(/entail closes #11 with your answer as the reason\./u)).toBeTruthy();
    expect(api.sent(/answer/u)[0]!.body).toEqual({ call: "no", answer: "Only real whitespace separates words." });
  });

  it("shows a receipt still in its window after a reload, and lets it go when the window closes", async () => {
    const item = aCall({ id: 11, issue: { number: 174, title: "Glitter", url: "u", author: "r" } });
    fakeApi({ waiting: { items: [], held: [held(item, {}, 1_200)], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    expect(await screen.findByRole("article", { name: "Confirmed. #174" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("article", { name: "Confirmed. #174" })).toBeNull(), { timeout: 3_000 });
  });

  it("marks an item judged again after an edit", async () => {
    fakeApi({ waiting: { items: [aCall({ rejudged: true })], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    expect(await screen.findByText("re-judged after an edit")).toBeTruthy();
  });

  it("is driven from the keyboard: j moves, c confirms, o overrides, Esc cancels, and 2 goes to the log", async () => {
    const first = aCall({ id: 21, issue: { number: 1, title: "First", url: "u", author: "r" }, waitingSince: "2026-11-01T00:00:00Z" });
    const second = aCall({ id: 22, issue: { number: 2, title: "Second", url: "u", author: "r" }, waitingSince: "2026-11-02T00:00:00Z" });
    const api = fakeApi({ waiting: { items: [first, second], held: [], actedAlone: { count: 0, repos: [] } } });
    renderBoard();
    await screen.findByText("Second");
    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    expect(document.querySelector(".item.focused h3")?.textContent).toBe("Second");
    await userEvent.keyboard("o");
    expect(await screen.findByRole("textbox", { name: "Your reason" })).toBeTruthy();
    act(() => void fireEvent.keyDown(screen.getByRole("textbox", { name: "Your reason" }), { key: "Escape" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Your reason" })).toBeNull());
    await userEvent.keyboard("c");
    await waitFor(() => expect(api.sent(/POST \/api\/calls\/22\/confirm/u)).toHaveLength(1));
    await userEvent.keyboard("2");
    expect(window.location.hash).toBe("#/log");
  });
});
