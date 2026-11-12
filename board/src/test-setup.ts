import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

// jsdom lays nothing out, so it has no scrolling.
Element.prototype.scrollIntoView = function scrollIntoView() {};
