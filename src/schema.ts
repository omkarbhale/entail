/**
 * A small schema builder for model run outputs. Each schema is written once in
 * TypeScript: its type is inferred with {@link Infer}, it is emitted as JSON
 * Schema for `claude -p --json-schema` through {@link emitJsonSchema}, and it
 * checks a run's structured output with {@link checkAgainst}.
 *
 * Only the plain JSON Schema keywords are emitted (`type`, `properties`,
 * `required`, `additionalProperties`, `enum`, `items`, `anyOf` and
 * `description`), so every schema stays within what structured outputs accept.
 * Counts and other rules a schema cannot state are left to the mechanical
 * checks of the step that reads the output.
 */

export type JsonSchema = { readonly [keyword: string]: unknown };

export interface Schema<T> {
  /** The JSON Schema this schema emits. */
  readonly json: JsonSchema;
  /** Problems with `value` at `path`, empty when it conforms. */
  problems(value: unknown, path: string): string[];
  /** Carries the type for {@link Infer}; never set at run time. */
  readonly type?: T;
}

/** The TypeScript type of a value a schema accepts. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** Emits a schema as the JSON Schema text `--json-schema` takes. */
export function emitJsonSchema(schema: Schema<unknown>): string {
  return JSON.stringify(schema.json);
}

/** Every way `value` fails `schema`, empty when it conforms. */
export function checkAgainst(schema: Schema<unknown>, value: unknown): string[] {
  return schema.problems(value, "$");
}

function described(json: Record<string, unknown>, description: string | undefined): JsonSchema {
  return description === undefined ? json : { ...json, description };
}

export function string(description?: string): Schema<string> {
  return {
    json: described({ type: "string" }, description),
    problems: (value, path) => (typeof value === "string" ? [] : [`${path} is not a string`]),
  };
}

export function boolean(description?: string): Schema<boolean> {
  return {
    json: described({ type: "boolean" }, description),
    problems: (value, path) => (typeof value === "boolean" ? [] : [`${path} is not a boolean`]),
  };
}

/** One of a fixed list of strings. */
export function oneOf<const V extends readonly [string, ...string[]]>(values: V, description?: string): Schema<V[number]> {
  return {
    json: described({ type: "string", enum: [...values] }, description),
    problems: (value, path) =>
      typeof value === "string" && values.includes(value) ? [] : [`${path} is not one of ${values.map((v) => JSON.stringify(v)).join(", ")}`],
  };
}

export function arrayOf<T>(items: Schema<T>, description?: string): Schema<T[]> {
  return {
    json: described({ type: "array", items: items.json }, description),
    problems: (value, path) =>
      Array.isArray(value) ? value.flatMap((item, index) => items.problems(item, `${path}[${index}]`)) : [`${path} is not an array`],
  };
}

/** The schema's value, or null. */
export function nullable<T>(inner: Schema<T>, description?: string): Schema<T | null> {
  return {
    json: described({ anyOf: [inner.json, { type: "null" }] }, description),
    problems: (value, path) => (value === null ? [] : inner.problems(value, path)),
  };
}

type Shape = { readonly [key: string]: Schema<unknown> };
type ObjectOf<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

/** An object with exactly these properties, all required. */
export function object<const S extends Shape>(shape: S, description?: string): Schema<ObjectOf<S>> {
  const keys = Object.keys(shape);
  const properties = Object.fromEntries(keys.map((key) => [key, shape[key]!.json]));
  return {
    json: described({ type: "object", properties, required: keys, additionalProperties: false }, description),
    problems: (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} is not an object`];
      const record = value as Record<string, unknown>;
      const problems: string[] = [];
      for (const key of keys) {
        if (!Object.hasOwn(record, key)) problems.push(`${path}.${key} is missing`);
        else problems.push(...shape[key]!.problems(record[key], `${path}.${key}`));
      }
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(shape, key)) problems.push(`${path}.${key} is not allowed`);
      }
      return problems;
    },
  };
}
