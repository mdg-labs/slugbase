import { afterAll, beforeAll } from "vitest";
import { createTestDatabase, type TestDatabase, type TestDatabaseOptions } from "@slugbase/db/testing";

// The Postgres test harness of doc 08 section 3.2. The database lifecycle (the
// template, the clones, the pools as slugbase_app and as the owner) lives in
// @slugbase/db/testing, the one place outside the product code that may hold a
// raw database handle (doc 09 section 2.1); this module adds the vitest hooks.

export { createTestDatabase, dropTestTemplate, testTemplateName, withTestDatabase } from "@slugbase/db/testing";
export type { MigrationChain, TestDatabase, TestDatabaseOptions, TestSql } from "@slugbase/db/testing";

// Waiting for another run to release the cluster lock, or for another worker to
// build the template, counts against a hook.
const HOOK_TIMEOUT_MS = 300_000;

/**
 * Gives the test file its own database: created before the first test and
 * dropped after the last, also when a test failed. The accessor returns the
 * database once `beforeAll` has run.
 */
export function useTestDatabase(options: TestDatabaseOptions = {}): () => TestDatabase {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createTestDatabase(options);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    const current = database;
    database = undefined;
    await current?.drop();
  }, HOOK_TIMEOUT_MS);

  return () => {
    if (database === undefined) {
      throw new Error("the test database is not available before beforeAll has run");
    }
    return database;
  };
}
