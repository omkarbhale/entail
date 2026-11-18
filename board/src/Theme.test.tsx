import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import themeScript from "../public/theme.js?raw";
import { fakeApi, renderBoard } from "./test-support.tsx";

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("Theme", () => {
  it("follows the system until the navbar toggle picks a theme, which is remembered", async () => {
    fakeApi();
    renderBoard();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const toggle = await screen.findByRole("button", { name: "Switch to dark theme" });
    await userEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("entail.theme")).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("entail.theme")).toBe("light");
  });

  it("applies a stored choice on load, before the board renders and once it has", async () => {
    window.localStorage.setItem("entail.theme", "dark");
    new Function(themeScript)();
    expect(document.documentElement.dataset.theme).toBe("dark");
    fakeApi();
    renderBoard();
    expect(await screen.findByRole("button", { name: "Switch to light theme" })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
