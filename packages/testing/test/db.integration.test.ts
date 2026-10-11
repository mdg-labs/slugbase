import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase, useTestDatabase, withTestDatabase } from "../src/db.ts";

// @slugbase/testing/db end to end: the hooks give a file its own database and
// drop it when the file is done (doc 08 section 3.2).

const HOOK_TIMEOUT_MS = 300_000;

let observed: { name: string; template: string } | undefined;

// Runs after the hooks of the suite below, which end first.
afterAll(async () => {
  if (observed === undefined) {
    throw new Error("the suite below recorded no database");
  }
  const { name } = observed;
  await withTestDatabase(async (other) => {
    const rows = await other.app<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS present`;
    expect(rows[0]?.present).toBe(false);
  });
}, HOOK_TIMEOUT_MS);

describe("useTestDatabase", () => {
  const database = useTestDatabase();

  it("gives the file a database cloned from the template, with the app and owner pools", async () => {
    const db = database();
    observed = { name: db.name, template: db.template.name };
    const app = await db.app<{ user: string; name: string }[]>`SELECT current_user AS user, current_database() AS name`;
    expect(app[0]).toEqual({ user: "slugbase_app", name: db.name });
    const owner = await db.owner<{ user: string }[]>`SELECT current_user AS user`;
    expect(owner[0]?.user).toBe("slugbase_owner");
    expect(db.name).toMatch(/^test_[0-9a-f]{16}$/);
    expect(db.template.name).toMatch(/^slugbase_tpl_[0-9a-f]{32}$/);
  });

  it("lets the owner insert what the app role then reads", async () => {
    const db = database();
    await db.owner.unsafe("CREATE TABLE note (body text NOT NULL)");
    await db.owner.unsafe("GRANT SELECT ON note TO slugbase_app");
    await db.owner.unsafe("INSERT INTO note VALUES ('kept')");
    const rows = await db.app<{ body: string }[]>`SELECT body FROM note`;
    expect(rows.map((row) => row.body)).toEqual(["kept"]);
  });
});

describe("the harness exports", () => {
  it("creates a database without hooks, and is dropped on request", async () => {
    const db = await createTestDatabase();
    try {
      const rows = await db.app<{ one: number }[]>`SELECT 1 AS one`;
      expect(rows[0]?.one).toBe(1);
    } finally {
      await db.drop();
    }
  }, HOOK_TIMEOUT_MS);
});
