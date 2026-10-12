import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

// The declarative SQL gives slugbase_app, the role the worker connects as,
// its rights on the pgboss schema (doc 05 section 3.1): the migrated database
// holds the schema before pg-boss installs anything, and whatever the owner
// role then creates in it is usable by the app role without a grant of its own.

const HOOK_TIMEOUT_MS = 300_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.owner.unsafe(`
    CREATE TABLE pgboss.probe (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text NOT NULL);
    CREATE SEQUENCE pgboss.probe_seq;
    CREATE FUNCTION pgboss.probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
  `);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

describe("the pgboss schema in a migrated database", () => {
  it("exists and is owned by slugbase_owner", async () => {
    const rows = await db.app<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'`;
    expect(rows[0]?.owner).toBe("slugbase_owner");
  });

  it("lets slugbase_app read and write what the owner creates there", async () => {
    await db.app.unsafe(`INSERT INTO pgboss.probe (note) VALUES ('a')`);
    await db.app.unsafe(`UPDATE pgboss.probe SET note = 'b'`);
    const rows = await db.app<{ note: string }[]>`SELECT note FROM pgboss.probe`;
    expect(rows).toEqual([{ note: "b" }]);
    await db.app.unsafe(`DELETE FROM pgboss.probe`);
    const next = await db.app<{ n: string }[]>`SELECT nextval('pgboss.probe_seq')::text AS n`;
    expect(next[0]?.n).toBe("1");
    const fn = await db.app<{ n: number }[]>`SELECT pgboss.probe_fn() AS n`;
    expect(fn[0]?.n).toBe(1);
  });

  it("gives slugbase_app no right to create or change objects there", async () => {
    await expect(db.app.unsafe(`CREATE TABLE pgboss.intruder (id int)`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe(`DROP TABLE pgboss.probe`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe(`TRUNCATE pgboss.probe`)).rejects.toMatchObject({ code: "42501" });
  });
});
