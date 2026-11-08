import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCommentRules,
  attributionLine,
  CommentRuleError,
  commentRuleViolations,
  composeComment,
  hiddenMarker,
  markedTickets,
  possessive,
} from "../src/comment-rules.ts";

test("the attribution line names the owner in the possessive", () => {
  assert.equal(attributionLine("Omkar"), "Speaking from Omkar's entail:");
});

test("the possessive reads correctly for names ending in s and other edge cases", () => {
  const cases: [string, string][] = [
    ["Omkar", "Omkar's"],
    ["James", "James'"],
    ["Charles", "Charles'"],
    ["JONAS", "JONAS'"],
    ["Max", "Max's"],
    ["Liz", "Liz's"],
    ["Li", "Li's"],
    ["Omkar Bhale", "Omkar Bhale's"],
    ["  Ada   Lovelace  ", "Ada Lovelace's"],
    ["José", "José's"],
    ["Zoë", "Zoë's"],
    ["李", "李's"],
    ["Bob Jr.", "Bob Jr.'s"],
    ["X", "X's"],
    // A name already in the possessive is not doubled.
    ["Omkar's", "Omkar's"],
    ["James'", "James'"],
    ["Omkar’s", "Omkar’s"],
  ];
  for (const [name, expected] of cases) assert.equal(possessive(name), expected, name);
});

test("a display name that is empty or more than one line is refused", () => {
  assert.throws(() => attributionLine(""), /not set/);
  assert.throws(() => attributionLine("   "), /not set/);
  assert.throws(() => attributionLine("Omkar\n/close"), /one line/);
});

test("the hidden marker carries the ticket's record id and starts with no slash", () => {
  assert.equal(hiddenMarker(42), "<!-- entail ticket 42 -->");
  assert.deepEqual(markedTickets(`a\n${hiddenMarker(42)}\nb ${hiddenMarker(7)}`), [42, 7]);
  assert.throws(() => hiddenMarker(0));
  assert.throws(() => hiddenMarker(1.5));
});

test("a composed comment opens with the attribution line and ends with the marker on its own line", () => {
  const body = composeComment("James", 42, "Cleared.\n\nC1: reads standard input.");
  assert.equal(body, "Speaking from James' entail:\n\nCleared.\n\nC1: reads standard input.\n\n<!-- entail ticket 42 -->");
  assert.deepEqual(commentRuleViolations(body, "James", 42), []);
  assert.ok(body.split("\n").every((line) => !line.startsWith("/")), "the marker is placed so no line starts with /");
});

test("the comment rules refuse a body missing the attribution line or the marker, or with a line starting with /", () => {
  const good = composeComment("Omkar", 42, "Cleared.");
  assert.doesNotThrow(() => assertCommentRules(good, "Omkar", 42));

  const missingAttribution = `Cleared.\n\n${hiddenMarker(42)}`;
  assert.match(commentRuleViolations(missingAttribution, "Omkar", 42).join(), /attribution line/);

  const attributionNotFirst = `Cleared.\n${attributionLine("Omkar")}\n${hiddenMarker(42)}`;
  assert.match(commentRuleViolations(attributionNotFirst, "Omkar", 42).join(), /attribution line/);

  const otherOwner = composeComment("James", 42, "Cleared.");
  assert.match(commentRuleViolations(otherOwner, "Omkar", 42).join(), /attribution line/);

  const missingMarker = `${attributionLine("Omkar")}\n\nCleared.`;
  assert.match(commentRuleViolations(missingMarker, "Omkar", 42).join(), /hidden marker for ticket 42/);

  const otherTicket = `${attributionLine("Omkar")}\n\nCleared.\n\n${hiddenMarker(41)}`;
  assert.match(commentRuleViolations(otherTicket, "Omkar", 42).join(), /hidden marker for ticket 42/);

  const twoMarkers = `${good}\n${hiddenMarker(42)}`;
  assert.match(commentRuleViolations(twoMarkers, "Omkar", 42).join(), /more than one/);

  for (const slashed of ["/close", "  /label ~bug", "\t/assign @someone", "/"]) {
    const body = `${attributionLine("Omkar")}\n\n${slashed}\n\n${hiddenMarker(42)}`;
    assert.match(commentRuleViolations(body, "Omkar", 42).join(), /line 3 starts with "\/"/, JSON.stringify(slashed));
  }
  const crlf = `${attributionLine("Omkar")}\r\n\r\n/close\r\n${hiddenMarker(42)}`;
  assert.match(commentRuleViolations(crlf, "Omkar", 42).join(), /starts with "\/"/);

  // A slash inside a line is fine; only a line's start matters.
  assert.deepEqual(commentRuleViolations(composeComment("Omkar", 42, "Run `npm test` in src/ and see a/b."), "Omkar", 42), []);

  assert.throws(() => assertCommentRules(missingMarker, "Omkar", 42), CommentRuleError);
  assert.throws(() => composeComment("Omkar", 42, "/close"), CommentRuleError);
});
