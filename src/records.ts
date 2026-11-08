import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./store-schema.ts";
import { Store } from "./store.ts";

/**
 * The text export of the store that the records repo holds (ADR-0009).
 *
 * It is deterministic: the same store always exports the same bytes, so the
 * records repo's history shows each change and nothing else. It is the whole
 * store, every table, and nothing outside it: the status file, the
 * operational log and cursors are not records (ADR-0019).
 *
 * - `records.json` is the manifest: the export format, the store's schema
 *   version, its schema exactly as the store holds it, and each table's row
 *   count.
 * - `tables/<table>.jsonl` holds one table, one row per line in primary key
 *   order, each row a JSON object with the table's columns in order.
 *
 * Restoring means cloning the records repo and importing it into a fresh
 * store with {@link importRecords}.
 */
export const RECORDS_FORMAT = 1;
export const MANIFEST_FILE = "records.json";
export const TABLES_DIRECTORY = "tables";

export interface SchemaEntry {
  type: "table" | "index" | "trigger";
  name: string;
  sql: string;
}

export interface RecordsManifest {
  format: number;
  schemaVersion: number;
  schema: SchemaEntry[];
  /** Each table's row count, by table name in name order. */
  tables: Record<string, number>;
}

/** The export's files, by path relative to the records repo, each with its full text. */
export type RecordsFiles = Map<string, string>;

/** The path of a table's file in the export. */
export function tableFile(table: string): string {
  return `${TABLES_DIRECTORY}/${table}.jsonl`;
}

const SCHEMA_TYPES: readonly SchemaEntry["type"][] = ["table", "index", "trigger"];

/**
 * Exports the store at `storePath` as text. It reads through a read-only
 * connection of its own inside one read transaction, so the export is one
 * consistent snapshot even while entail keeps writing.
 */
export function exportRecords(storePath: string): RecordsFiles {
  const db = new DatabaseSync(storePath, { readOnly: true, timeout: 5_000 });
  try {
    db.exec("BEGIN");
    try {
      return exportFrom(db);
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

function exportFrom(db: DatabaseSync): RecordsFiles {
  const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  const schema = db
    .prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }))
    .filter((entry): entry is SchemaEntry => (SCHEMA_TYPES as readonly string[]).includes(entry.type))
    .sort((a, b) => SCHEMA_TYPES.indexOf(a.type) - SCHEMA_TYPES.indexOf(b.type) || compare(a.name, b.name));

  const files: RecordsFiles = new Map();
  const tables: Record<string, number> = {};
  for (const { name } of schema.filter((entry) => entry.type === "table")) {
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
      .all(name)
      .map((row) => String(row.name));
    const rows = db.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(name)} ORDER BY rowid`).all();
    files.set(tableFile(name), rows.map((row) => rowLine(name, columns, row)).join(""));
    tables[name] = rows.length;
  }

  const manifest: RecordsManifest = { format: RECORDS_FORMAT, schemaVersion, schema, tables };
  files.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return new Map([...files].sort(([a], [b]) => compare(a, b)));
}

function rowLine(table: string, columns: readonly string[], row: Record<string, SQLOutputValue>): string {
  const out: Record<string, string | number | null> = {};
  for (const column of columns) {
    const value = row[column];
    if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      out[column] = value;
    } else {
      throw new Error(`cannot export ${table}.${column}: the store holds a value that is not text, a finite number or null`);
    }
  }
  return `${JSON.stringify(out)}\n`;
}

/** The export could not be imported; the store it started is removed. */
export class RecordsImportError extends Error {
  constructor(why: string, options?: ErrorOptions) {
    super(`cannot import the records: ${why}`, options);
    this.name = "RecordsImportError";
  }
}

/**
 * Imports an export, such as a clone of the records repo, into a fresh store
 * at `storePath`. Every row comes back with its own id, every ticket with its
 * current state, and the store's integrity rules hold over the result: rows
 * go in before the triggers that guard new writes, then every foreign key is
 * checked. An export from an older entail is brought up to date as its store
 * would have been. Throws {@link RecordsImportError}, leaving no store behind.
 */
export function importRecords(exportDirectory: string, storePath: string): RecordsManifest {
  if (existsSync(storePath)) throw new RecordsImportError(`a store already exists at ${storePath}`);
  const manifest = readManifest(exportDirectory);
  try {
    const db = new DatabaseSync(storePath, { enableForeignKeyConstraints: false });
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const entry of manifest.schema.filter((e) => e.type === "table")) db.exec(entry.sql);
      for (const [table, count] of Object.entries(manifest.tables)) insertRows(db, exportDirectory, table, count);
      for (const entry of manifest.schema.filter((e) => e.type !== "table")) db.exec(entry.sql);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new RecordsImportError(`${broken.length} rows refer to records the export does not hold, such as one in ${String(broken[0]!.table)}`);
      }
      db.exec(`PRAGMA user_version = ${manifest.schemaVersion}`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
    // Opening it as entail's store brings an older schema up to date.
    Store.open(storePath).close();
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${storePath}${suffix}`, { force: true });
    if (error instanceof RecordsImportError) throw error;
    throw new RecordsImportError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return manifest;
}

function readManifest(exportDirectory: string): RecordsManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(exportDirectory, MANIFEST_FILE), "utf8"));
  } catch (error) {
    throw new RecordsImportError(`${MANIFEST_FILE} cannot be read`, { cause: error });
  }
  if (!isObject(manifest) || manifest.format !== RECORDS_FORMAT) {
    throw new RecordsImportError(`${MANIFEST_FILE} is not an entail records export of format ${RECORDS_FORMAT}`);
  }
  const { schemaVersion, schema, tables } = manifest;
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new RecordsImportError(`${MANIFEST_FILE} names no schema version`);
  }
  if (schemaVersion > SCHEMA_VERSION) {
    throw new RecordsImportError(`it was written by a newer entail (schema ${schemaVersion}, this entail reads ${SCHEMA_VERSION})`);
  }
  const validSchema =
    Array.isArray(schema) &&
    schema.every(
      (e) => isObject(e) && (SCHEMA_TYPES as readonly unknown[]).includes(e.type) && typeof e.name === "string" && typeof e.sql === "string",
    );
  if (!validSchema) throw new RecordsImportError(`${MANIFEST_FILE} holds no readable schema`);
  const tableNames = new Set((schema as SchemaEntry[]).filter((e) => e.type === "table").map((e) => e.name));
  const validTables =
    isObject(tables) &&
    Object.entries(tables).every(([name, count]) => tableNames.has(name) && typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
    Object.keys(tables).length === tableNames.size;
  if (!validTables) throw new RecordsImportError(`${MANIFEST_FILE} does not count the rows of every table in its schema`);
  return manifest as unknown as RecordsManifest;
}

function insertRows(db: DatabaseSync, exportDirectory: string, table: string, count: number): void {
  const file = tableFile(table);
  let text: string;
  try {
    text = readFileSync(join(exportDirectory, file), "utf8");
  } catch (error) {
    throw new RecordsImportError(`${file} cannot be read`, { cause: error });
  }
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  if (lines.length !== count) throw new RecordsImportError(`${file} holds ${lines.length} rows, and ${MANIFEST_FILE} counts ${count}`);
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  lines.forEach((line, index) => {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new RecordsImportError(`${file} line ${index + 1} is not JSON`, { cause: error });
    }
    if (!isObject(row) || !Object.values(row).every(isColumnValue)) {
      throw new RecordsImportError(`${file} line ${index + 1} is not a row of text, numbers and nulls`);
    }
    const columns = Object.keys(row);
    const key = columns.join("\u0000");
    let statement = statements.get(key);
    if (statement === undefined) {
      statement = db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      statements.set(key, statement);
    }
    statement.run(...(Object.values(row) as SQLInputValue[]));
  });
}

function isColumnValue(value: unknown): boolean {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Orders by code point, never by locale, so the export is the same everywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
