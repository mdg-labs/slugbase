import type { TestDatabase } from "@slugbase/db/testing";

const VACUUM_ATTEMPTS = 20;
const VACUUM_RETRY_DELAY_MS = 250;

/** The tables of the public schema whose visibility map, as `pg_class` last recorded it, does not cover every page. */
async function unmappedTables(database: Pick<TestDatabase, "owner">): Promise<string[]> {
  const rows = await database.owner<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'm') AND relallvisible < relpages ORDER BY relname`;
  return rows.map((row) => row.name);
}

/**
 * Vacuums the database until the visibility map marks every page of every table all-visible, the state a running instance's
 * autovacuum leaves its tables in. One VACUUM of rows just written can leave pages unmarked (none of the pages of the
 * dashboard fixture's `bookmarks` after the first one in 4 of 4 runs), and with pages unmarked an index cannot answer for its
 * entries without a visit to the heap, so the plans and timings of a run differ from those of a vacuumed table. Rejects with
 * the tables still unmarked when a bounded number of vacuums does not reach it.
 */
export async function vacuumUntilAllVisible(database: Pick<TestDatabase, "owner">): Promise<void> {
  let unmapped: string[] = [];
  for (let attempt = 1; attempt <= VACUUM_ATTEMPTS; attempt += 1) {
    await database.owner.unsafe("VACUUM (ANALYZE)");
    unmapped = await unmappedTables(database);
    if (unmapped.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, VACUUM_RETRY_DELAY_MS));
  }
  throw new Error(`the visibility map of ${unmapped.join(", ")} does not cover every page after ${String(VACUUM_ATTEMPTS)} vacuums`);
}
