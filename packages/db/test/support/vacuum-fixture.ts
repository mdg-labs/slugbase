import type { TestDatabase } from "../../src/testing.ts";

const VACUUM_ATTEMPTS = 20;
const VACUUM_RETRY_DELAY_MS = 250;

/**
 * Vacuums the tables until the visibility map marks every page of each all-visible. One VACUUM of a fixture just inserted can leave pages unmarked (measured on the dashboard
 * fixture: none of the 5 027 pages of `bookmarks` and none of the 225 of `bookmark_tags` after the first VACUUM in 4 of 4 runs, every page after a later one). With pages unmarked an
 * index cannot answer for the entries on them without a visit to the heap, so the plans and the timings a suite measures differ from those of a vacuumed table (the 40 timed round trips of the dashboard took
 * 48 to 62 ms with an empty map and 23 to 30 ms with a full one). A suite that measures time fixes that state before it measures.
 */
export async function vacuumUntilAllVisible(database: TestDatabase, tables: readonly string[]): Promise<void> {
  for (let attempt = 1; attempt <= VACUUM_ATTEMPTS; attempt += 1) {
    await database.owner.unsafe(`VACUUM (ANALYZE) ${tables.join(", ")}`);
    const rows = await database.owner<{ name: string; pages: number; visible: number }[]>`
      SELECT relname AS name, relpages AS pages, relallvisible AS visible FROM pg_class WHERE oid = ANY (${tables.map((table) => `public.${table}`)}::regclass[])`;
    if (rows.length === tables.length && rows.every((row) => row.visible >= row.pages)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, VACUUM_RETRY_DELAY_MS));
  }
  throw new Error(`the visibility map of ${tables.join(", ")} does not cover every page after ${String(VACUUM_ATTEMPTS)} vacuums`);
}
