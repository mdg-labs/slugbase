import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testTemplateName, withTestDatabase, type TestDatabase } from "../src/testing.ts";

// The template-database harness against the development Postgres of
// compose.dev.yml (doc 08 section 3.2): a database per file, cloned from a
// template that is built once per migration hash.

const HOOK_TIMEOUT_MS = 300_000;
const MIGRATIONS = new URL("../migrations/", import.meta.url);

interface Journal {
  entries: { tag: string }[];
}
const journalLength = (JSON.parse(readFileSync(new URL("meta/_journal.json", MIGRATIONS), "utf8")) as Journal)
  .entries.length;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

async function exists(sql: TestDatabase["app"], name: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS present`;
  return rows[0]?.present === true;
}

describe("the database of a test file", () => {
  it("is named test_ followed by random hex, apart from the template", async () => {
    expect(db.name).toMatch(/^test_[0-9a-f]{16}$/);
    expect(db.template.name).toBe(testTemplateName());
    const current = await db.app<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current[0]?.name).toBe(db.name);
  });

  it("is a clone of a template that is marked as one and takes no connection", async () => {
    const rows = await db.app<{ istemplate: boolean; allowconn: boolean }[]>`
      SELECT datistemplate AS istemplate, datallowconn AS allowconn FROM pg_database WHERE datname = ${db.template.name}`;
    expect(rows[0]).toEqual({ istemplate: true, allowconn: false });
  });

  it("holds the chain the template applied, with the bookkeeping the server reads as slugbase_app", async () => {
    const rows = await db.app<{ count: string }[]>`SELECT count(*) FROM drizzle.migrations_core`;
    expect(Number(rows[0]?.count)).toBe(journalLength);
    const fn = await db.app<{ id: string | null }[]>`SELECT public.app_workspace_id()::text AS id`;
    expect(fn[0]?.id).toBeNull();
  });
});

describe("the database-level privileges", () => {
  async function acl(sql: TestDatabase["app"], name: string): Promise<string[]> {
    const rows = await sql<{ acl: string[] | null }[]>`
      SELECT array(SELECT a::text FROM unnest(datacl) AS a ORDER BY 1) AS acl FROM pg_database WHERE datname = ${name}`;
    return rows[0]?.acl ?? [];
  }

  it("are those roles.sql gave the template, which a clone does not copy", async () => {
    const template = await acl(db.app, db.template.name);
    expect(template.length).toBeGreaterThan(0);
    expect(await acl(db.app, db.name)).toEqual(template);
  });

  it("let only slugbase_owner create schemas", async () => {
    const rows = await db.app<{ role: string; connect: boolean; create: boolean }[]>`
      SELECT r AS role,
             has_database_privilege(r, current_database(), 'CONNECT') AS connect,
             has_database_privilege(r, current_database(), 'CREATE') AS create
      FROM unnest(ARRAY['slugbase_owner', 'slugbase_app', 'slugbase_migrator', 'slugbase_system']) AS r ORDER BY r`;
    expect(rows).toEqual([
      { role: "slugbase_app", connect: true, create: false },
      { role: "slugbase_migrator", connect: true, create: false },
      { role: "slugbase_owner", connect: true, create: true },
      { role: "slugbase_system", connect: true, create: false },
    ]);
  });

  it("let the owner create a schema, as migrate does", async () => {
    await db.owner`CREATE SCHEMA harness_grant_probe`;
    await db.owner`DROP SCHEMA harness_grant_probe`;
  });
});

describe("the pool as slugbase_app", () => {
  it("connects as slugbase_app, which is neither a superuser nor exempt from row-level security", async () => {
    const rows = await db.app<{ user: string; super: boolean; bypass: boolean }[]>`
      SELECT current_user AS user, r.rolsuper AS super, r.rolbypassrls AS bypass
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(rows[0]).toEqual({ user: "slugbase_app", super: false, bypass: false });
  });

  it("cannot create a table", async () => {
    await expect(db.app.unsafe("CREATE TABLE app_made (a integer)")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the pool as the owner", () => {
  it("acts as slugbase_owner, which is not a superuser", async () => {
    const rows = await db.owner<{ user: string; super: boolean }[]>`
      SELECT current_user AS user, r.rolsuper AS super FROM pg_roles r WHERE r.rolname = current_user`;
    expect(rows[0]).toEqual({ user: "slugbase_owner", super: false });
  });

  it("creates and fills a table that slugbase_app then reads", async () => {
    await db.owner.unsafe("CREATE TABLE probe (a integer NOT NULL)");
    await db.owner.unsafe("GRANT SELECT ON probe TO slugbase_app");
    await db.owner.unsafe("INSERT INTO probe VALUES (1), (2)");
    const rows = await db.app<{ a: number }[]>`SELECT a FROM probe ORDER BY a`;
    expect(rows.map((row) => row.a)).toEqual([1, 2]);
  });

  it("does not hand tests a superuser: neither pool can create a role or read another database's data", async () => {
    for (const pool of [db.app, db.owner]) {
      await expect(pool.unsafe("CREATE ROLE test_should_not_exist")).rejects.toMatchObject({ code: "42501" });
      const rows = await pool<{ super: string }[]>`SELECT current_setting('is_superuser') AS super`;
      expect(rows[0]?.super).toBe("off");
    }
  });
});

describe("dropping", () => {
  it("removes the database and ends its pools, and may be called twice", async () => {
    const other = await createTestDatabase();
    const name = other.name;
    expect(await exists(db.app, name)).toBe(true);
    await other.drop();
    expect(await exists(db.app, name)).toBe(false);
    await expect(other.drop()).resolves.toBeUndefined();
  });

  it("happens when the work in withTestDatabase fails", async () => {
    let name = "";
    await expect(
      withTestDatabase(async (inner) => {
        name = inner.name;
        await inner.owner.unsafe("CREATE TABLE half_done (a integer)");
        throw new Error("the test failed");
      }),
    ).rejects.toThrow("the test failed");
    expect(name).toMatch(/^test_/);
    expect(await exists(db.app, name)).toBe(false);
  });
});
