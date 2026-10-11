import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testTemplateName, type TestDatabase } from "../src/testing.ts";

// A second test file on the same server: the template exists, so its database
// is a copy of it and no migration runs (doc 08 section 3.2).

const HOOK_TIMEOUT_MS = 300_000;

let first: TestDatabase;
let second: TestDatabase;

beforeAll(async () => {
  first = await createTestDatabase();
  second = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([first.drop(), second.drop()]);
}, HOOK_TIMEOUT_MS);

describe("a second use of the template", () => {
  it("finds the template and builds nothing", () => {
    expect(second.template.built).toBe(false);
    expect(second.template.name).toBe(testTemplateName());
    expect(second.template.name).toBe(first.template.name);
    expect(second.name).not.toBe(first.name);
  });

  it("copies the bookkeeping rows instead of writing them again", async () => {
    // A row keeps the transaction id that wrote it. A migration applied to each
    // database would carry that database's own transaction ids.
    const writers = await Promise.all(
      [first, second].map((db) => db.app<{ writer: string }[]>`SELECT xmin::text AS writer FROM drizzle.migrations_core ORDER BY id`),
    );
    expect(writers[0]?.length).toBeGreaterThan(0);
    expect(writers[1]).toEqual(writers[0]);
  });

  it("keeps the databases apart", async () => {
    await first.owner.unsafe("CREATE TABLE only_in_first (a integer)");
    const rows = await second.app<{ present: boolean }[]>`SELECT to_regclass('public.only_in_first') IS NOT NULL AS present`;
    expect(rows[0]?.present).toBe(false);
  });
});
