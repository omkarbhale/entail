import { createElement as h, type ReactNode } from "react";

/** A stored ISO time, shown to the minute in UTC, as every page shows times. */
export function Time({ iso }: { iso: string }): ReactNode {
  return h("time", { dateTime: iso }, `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);
}

/** A small spinning mark beside the words of something in flight. */
export function Spinner(): ReactNode {
  return h("span", { className: "spinner", "aria-hidden": true });
}
