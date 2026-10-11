import { createHash } from "node:crypto";
import {
  isNonTransactional,
  NON_TRANSACTIONAL_MARKER,
  splitStatements,
  STATEMENT_BREAKPOINT,
} from "../src/migrate.ts";

// The format itself is defined where it is applied, in src/migrate.ts.
export { isNonTransactional, NON_TRANSACTIONAL_MARKER, splitStatements, STATEMENT_BREAKPOINT };

// Pure helpers of the migration generator (generate-migration.ts). They hold no
// state and touch no file, so the unit tests drive them with SQL text.
//
// Migration file format, for the generator and for whatever applies the files:
//
//   - A file is a list of statements separated by STATEMENT_BREAKPOINT lines.
//     A statement ends in `;`, and a custom-SQL statement (below) may hold
//     several of them.
//   - A file whose first line is NON_TRANSACTIONAL_MARKER must be applied
//     outside a transaction, one statement at a time. The generator writes
//     only a single `CREATE INDEX CONCURRENTLY` statement into such a file.
//   - Every other file is applied in one transaction.
//   - The statements that come from `src/sql/` start with CUSTOM_SQL_MARKER and
//     the hash of those files, then one `-- src/sql/<file>` line per file.

export const CUSTOM_SQL_MARKER = "-- slugbase:custom-sql";

export interface SqlFile {
  name: string;
  content: string;
}

export interface SplitIndexes {
  /** Statements that stay in the transactional migration. */
  transactional: string[];
  /** `CREATE INDEX CONCURRENTLY` statements, each for a non-transactional migration of its own. */
  concurrent: string[];
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:(CONCURRENTLY)\s+)?(?:IF\s+NOT\s+EXISTS\s+)?` +
    String.raw`(?:(?!ON\s)${IDENTIFIER}\s+)?ON\s+(?:ONLY\s+)?(${IDENTIFIER})(?:\s*\.\s*(${IDENTIFIER}))?`,
  "i",
);
const LEADING_COMMENTS = /^(?:[ \t]*--[^\n]*\n|\s*\n)+/;

export function joinStatements(statements: readonly string[]): string {
  return statements.length === 0 ? "" : `${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
}

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier.toLowerCase();
}

export function tableKey(schema: string | undefined, table: string): string {
  return `${schema === undefined || schema === "" ? "public" : schema}.${table}`;
}

/**
 * The tables a drizzle-kit snapshot describes, as `schema.table` keys. An
 * unreadable snapshot is an error: a silent empty set would leave every
 * index on an existing table transactional.
 */
export function tablesOfSnapshot(snapshot: unknown): Set<string> {
  if (typeof snapshot !== "object" || snapshot === null || !("tables" in snapshot)) {
    throw new Error("snapshot has no `tables` object");
  }
  const { tables } = snapshot;
  if (typeof tables !== "object" || tables === null) {
    throw new Error("snapshot has no `tables` object");
  }
  const keys = new Set<string>();
  for (const table of Object.values(tables as Record<string, unknown>)) {
    if (typeof table !== "object" || table === null || !("name" in table) || typeof table.name !== "string") {
      throw new Error("snapshot holds a table without a name");
    }
    const schema = "schema" in table && typeof table.schema === "string" ? table.schema : undefined;
    keys.add(tableKey(schema, table.name));
  }
  return keys;
}

/**
 * Splits the statements of a generated migration. A `CREATE INDEX` on a table
 * in `existingTables` (one an earlier migration created) becomes `CREATE INDEX
 * CONCURRENTLY`, so a rolling deploy never blocks writes on it (doc 05
 * section 5.2). It cannot run inside a transaction, so it is returned apart.
 * An index on a table the same migration creates stays where it is.
 */
export function rewriteIndexesConcurrently(sql: string, existingTables: ReadonlySet<string>): SplitIndexes {
  const result: SplitIndexes = { transactional: [], concurrent: [] };
  for (const statement of splitStatements(sql)) {
    const comments = LEADING_COMMENTS.exec(statement)?.[0] ?? "";
    const body = statement.slice(comments.length);
    const match = CREATE_INDEX.exec(body);
    const first = match?.[2];
    if (match === null || first === undefined) {
      result.transactional.push(statement);
      continue;
    }
    const second = match[3];
    const key = second === undefined ? tableKey(undefined, unquote(first)) : tableKey(unquote(first), unquote(second));
    if (match[1] !== undefined) {
      result.concurrent.push(statement);
    } else if (existingTables.has(key)) {
      result.concurrent.push(comments + body.replace(/^(CREATE\s+(?:UNIQUE\s+)?INDEX)(\s)/i, "$1 CONCURRENTLY$2"));
    } else {
      result.transactional.push(statement);
    }
  }
  return result;
}

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** SHA-256 over the file names and contents, in name order. */
export function hashSqlFiles(files: readonly SqlFile[]): string {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of ordered) {
    const content = normalizeNewlines(file.content);
    hash.update(`${file.name}\0${String(Buffer.byteLength(content))}\0${content}\0`);
  }
  return hash.digest("hex");
}

/** The statements that carry `src/sql/` into a migration: one per file, in name order. */
export function customSqlStatements(files: readonly SqlFile[]): string[] {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = hashSqlFiles(files);
  return ordered.map((file, index) => {
    const header = `-- src/sql/${file.name}`;
    const body = normalizeNewlines(file.content).trim();
    return index === 0 ? `${CUSTOM_SQL_MARKER} sha256=${hash}\n${header}\n${body}` : `${header}\n${body}`;
  });
}

export function nonTransactional(statements: readonly string[]): string {
  return `${NON_TRANSACTIONAL_MARKER}\n${joinStatements(statements)}`;
}
