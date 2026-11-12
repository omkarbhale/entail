import assert from "node:assert/strict";
import { test } from "node:test";
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

test("a nested schema emits only the plain JSON Schema keywords structured outputs accept", () => {
  const schema = object({
    call: oneOf(["go", "no", "ask"], "the call"),
    reason: string(),
    criteria: arrayOf(object({ id: string(), sentence: string(), path: nullable(string()) })),
    sure: boolean(),
  });
  const json = JSON.parse(emitJsonSchema(schema)) as JsonSchema;
  assert.equal(json.type, "object");
  assert.deepEqual(keywords(json).filter((keyword) => !ALLOWED_KEYWORDS.has(keyword)), []);
});
