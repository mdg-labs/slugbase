import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

// The read-back suite of the upgrade test (doc 08 section 3.4): what a database restored from a released schema's snapshot must
// still hold once every later migration has been applied. It is also what `scripts/db-snapshot.mjs` records at the moment it
// takes a snapshot, so the expectations are the facts of the dump itself. It runs as the superuser of the test server, which row-level
// security does not bind, so it sees every workspace.

/** What a snapshot records about the database it was taken from; `released/<tag>.json` holds it. */
export interface SnapshotRecord {
  /** The release tag the schema belongs to. */
  tag: string;
  /** The compressed dump next to the record. */
  file: string;
  /** SHA-256 of the compressed dump as committed. */
  fileSha256: string;
  /** Major version of the server the dump was taken from. */
  serverMajor: number;
  /** The last migration of the release; the snapshot has applied it and none after it. */
  lastMigration: string;
  /** SHA-256 of that migration's file, as `src/check/migration-checksums.json` records it. */
  lastMigrationSha256: string;
  /** Migrations the snapshot has applied, in the journal's order. */
  migrationCount: number;
  /** SHA-256 over the `<tag> <sha256>` line of every migration up to and including the last, in order. */
  chainSha256: string;
  /** Rows of every table of the `public` schema when the snapshot was taken. */
  rowCounts: Record<string, number>;
}

/** The directory of the snapshots: one `<tag>.sql.gz` and one `<tag>.json` for each released schema (doc 08 section 3.4). */
export const RELEASED_DIRECTORY = fileURLToPath(new URL("./released/", import.meta.url));

/** The record of every snapshot, the oldest schema first. */
export function readSnapshotRecords(): SnapshotRecord[] {
  return readdirSync(RELEASED_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(RELEASED_DIRECTORY, name), "utf8")) as SnapshotRecord)
    .sort((a, b) => a.migrationCount - b.migrationCount);
}

const TENANT_TABLES = `
  SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname = 'public'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped)
  ORDER BY c.relname`;

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** The tables of the `public` schema, which hold the instance's data. */
export async function publicTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`;
  return rows.map((row) => row.name);
}

/** The row count of every table of the `public` schema. */
export async function countRows(sql: postgres.Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await publicTables(sql)) {
    const rows = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${quoted(table)}`);
    counts[table] = rows[0]?.n ?? 0;
  }
  return counts;
}

/**
 * The ways `sql` breaks what the snapshot recorded, one sentence each; an empty list is a pass. The checks do not stop at the
 * first failure, so a migration that breaks several things reports all of them.
 *
 * - every table the snapshot held with rows still exists and holds at least as many (a migration may add rows, never lose them);
 * - every bookmark's slug is unique per owner in its workspace, and the column is still there to read;
 * - row-level security is enabled and forced, with a policy, on every table that has a `workspace_id` column.
 */
export async function readBack(sql: postgres.Sql, record: SnapshotRecord): Promise<string[]> {
  const violations: string[] = [];
  const tables = new Set(await publicTables(sql));
  for (const [table, before] of Object.entries(record.rowCounts)) {
    if (!tables.has(table)) {
      if (before > 0) {
        violations.push(`table ${table} held ${String(before)} rows in ${record.tag} and no longer exists`);
      }
      continue;
    }
    const rows = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${quoted(table)}`);
    const now = rows[0]?.n ?? 0;
    if (now < before) {
      violations.push(`table ${table} held ${String(before)} rows in ${record.tag} and holds ${String(now)}`);
    }
  }
  const slugColumn = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.bookmarks') AND a.attname = 'slug' AND a.attnum > 0 AND NOT a.attisdropped
    ) AS present`;
  if (slugColumn[0]?.present === true) {
    const duplicated = await sql<{ workspace_id: string; owner_id: string | null; slug: string; n: number }[]>`
      SELECT workspace_id, owner_id, slug, count(*)::int AS n FROM public.bookmarks
      WHERE slug IS NOT NULL GROUP BY workspace_id, owner_id, slug HAVING count(*) > 1`;
    for (const row of duplicated) {
      violations.push(`slug ${row.slug} is held by ${String(row.n)} bookmarks of one owner in workspace ${row.workspace_id}`);
    }
  } else if ((record.rowCounts["bookmarks"] ?? 0) > 0) {
    violations.push("bookmarks.slug no longer exists, so the slugs of the restored bookmarks are lost");
  }
  for (const table of await sql.unsafe<{ name: string; enabled: boolean; forced: boolean; policies: number }[]>(TENANT_TABLES)) {
    if (!table.enabled) {
      violations.push(`table ${table.name} has a workspace_id column but row-level security is not enabled`);
    }
    if (!table.forced) {
      violations.push(`table ${table.name} has a workspace_id column but row-level security is not forced`);
    }
    if (table.policies === 0) {
      violations.push(`table ${table.name} has a workspace_id column but no row-level security policy`);
    }
  }
  return violations;
}
