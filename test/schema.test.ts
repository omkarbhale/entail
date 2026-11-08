import assert from "node:assert/strict";
import { test } from "node:test";
import { criteriaSchema, gradeSchema, verdictSchema, type CriteriaOutput, type GradeOutput, type VerdictOutput } from "../src/model-schemas.ts";
import { arrayOf, boolean, checkAgainst, emitJsonSchema, nullable, object, oneOf, string, type JsonSchema } from "../src/schema.ts";

test("a schema is emitted as JSON Schema with every property required and no others allowed", () => {
  const schema = object({ name: string("who"), tags: arrayOf(oneOf(["a", "b"])), note: nullable(string()), done: boolean() });
  assert.deepEqual(JSON.parse(emitJsonSchema(schema)), {
    type: "object",
    properties: {
      name: { type: "string", description: "who" },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      done: { type: "boolean" },
    },
    required: ["name", "tags", "note", "done"],
    additionalProperties: false,
  });
});

test("the same schema checks a value and names every problem by its path", () => {
  const schema = object({ name: string(), tags: arrayOf(oneOf(["a", "b"])), note: nullable(string()) });
  assert.deepEqual(checkAgainst(schema, { name: "x", tags: ["a"], note: null }), []);
  assert.deepEqual(checkAgainst(schema, { tags: ["a", "c"], note: 1, extra: true }), [
    "$.name is missing",
    '$.tags[1] is not one of "a", "b"',
    "$.note is not a string",
    "$.extra is not allowed",
  ]);
  assert.deepEqual(checkAgainst(schema, []), ["$ is not an object"]);
});

const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "enum", "items", "anyOf", "description"]);

function keywords(json: JsonSchema): string[] {
  return Object.entries(json).flatMap(([keyword, value]) => {
    if (keyword === "properties") return [keyword, ...Object.values(value as Record<string, JsonSchema>).flatMap(keywords)];
    if (keyword === "items") return [keyword, ...keywords(value as JsonSchema)];
    if (keyword === "anyOf") return [keyword, ...(value as JsonSchema[]).flatMap(keywords)];
    return [keyword];
  });
}

for (const [name, schema] of [
  ["verdict", verdictSchema],
  ["criteria", criteriaSchema],
  ["grade", gradeSchema],
] as const) {
  test(`the ${name} schema emits only plain JSON Schema keywords`, () => {
    const json = JSON.parse(emitJsonSchema(schema)) as JsonSchema;
    assert.equal(json.type, "object");
    assert.deepEqual(keywords(json).filter((keyword) => !ALLOWED_KEYWORDS.has(keyword)), []);
  });
}

test("a settled verdict in the spec's shape conforms to the verdict schema", () => {
  const verdict: VerdictOutput = {
    size: { value: "fits", reason: "one small change" },
    readings: [{ id: "R1", reading: "read stdin when no file is given", observed_outcome: "`tally` counts piped text" }],
    pins_touched: [],
    vision_check: [{ line: "tally reads files or standard input.", mark: "matches" }],
    verdict: "settled",
    citations: [{ lines: ["tally reads files or standard input."], reading: "R1" }],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: null,
    open_readings: [],
    close_evidence: [],
    reason: "the standard-input line chooses the reading",
  };
  assert.deepEqual(checkAgainst(verdictSchema, verdict), []);
  assert.deepEqual(checkAgainst(verdictSchema, { ...verdict, verdict: "small" }), ['$.verdict is not one of "settled", "unopposed", "needs_the_owner", "close"']);
});

test("criteria and a grade in the spec's shape conform to their schemas", () => {
  const criteria: CriteriaOutput = {
    outcome: "criteria",
    criteria: [
      { id: "C1", sentence: "Output is plain when piped.", source: { kind: "issue", ref: null }, checks: [], states_reading: "R1" },
      { id: "C2", sentence: "The output format is unchanged.", source: { kind: "vision_line", ref: "tally prints one line per file." }, checks: [{ kind: "leaves_path", argument: "src/format.js" }], states_reading: null },
    ],
    product_call: null,
  };
  const grade: GradeOutput = {
    results: [{ id: "C1", result: "met", evidence: ["C1: ran `tally < a.txt | cat` — plain output"], reason: "the evidence shows it" }],
    beyond_criteria: [],
    reason: "every criterion is met",
  };
  assert.deepEqual(checkAgainst(criteriaSchema, criteria), []);
  assert.deepEqual(checkAgainst(gradeSchema, grade), []);
  assert.deepEqual(checkAgainst(criteriaSchema, { ...criteria, criteria: [{ ...criteria.criteria[0], checks: [{ kind: "runs_command", argument: "x" }] }] }), [
    '$.criteria[0].checks[0].kind is not one of "changes_path", "leaves_path", "check_passes"',
  ]);
});
