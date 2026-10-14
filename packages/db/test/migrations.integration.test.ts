import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNonTransactional, rewriteIndexesConcurrently, splitStatements } from "../scripts/migration-sql.ts";

// Applies the committed migrations to a throwaway database on the development
// Postgres of compose.dev.yml, statement by statement the way the file format
// says (doc 05 section 5.3), and checks what the SQL files define.

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const SQL_SOURCES = new URL("../src/sql/", import.meta.url);
const server = new URL(
  process.env.SLUGBASE_TEST_PG_URL ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);
const dbName = `test_migrations_${randomBytes(6).toString("hex")}`;
const WORKSPACE = "0190a000-0000-7000-8000-000000000001";
const ACCOUNT = "0190a000-0000-7000-8000-000000000002";

function connect(database: string): postgres.Sql {
  return postgres({
    host: server.hostname,
    port: Number(server.port),
    database,
    username: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
    max: 1,
    onnotice: () => undefined,
  });
}

interface Journal {
  entries: { tag: string }[];
}

async function applyAll(sql: postgres.Sql): Promise<void> {
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", MIGRATIONS), "utf8")) as Journal;
  for (const { tag } of journal.entries) {
    const file = readFileSync(new URL(`${tag}.sql`, MIGRATIONS), "utf8");
    const statements = splitStatements(file);
    if (isNonTransactional(file)) {
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    } else {
      await sql.begin(async (tx) => {
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
      });
    }
  }
}

let admin: postgres.Sql;
let db: postgres.Sql;

beforeAll(async () => {
  admin = connect(server.pathname.slice(1));
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  db = connect(dbName);
  await applyAll(db);
}, 120_000);

afterAll(async () => {
  try {
    await db.end({ timeout: 5 });
  } finally {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
}, 120_000);

describe("the committed migrations", () => {
  it("create the three extensions", async () => {
    const rows = await db<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm', 'btree_gin') ORDER BY extname`;
    expect(rows.map((row) => row.extname)).toEqual(["btree_gin", "citext", "pg_trgm"]);
  });

  it("define app_workspace_id() and app_account_id() as STABLE functions that do not elevate", async () => {
    const rows = await db<{ proname: string; provolatile: string; prosecdef: boolean; rettype: string }[]>`
      SELECT p.proname, p.provolatile, p.prosecdef, p.prorettype::regtype::text AS rettype
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('app_workspace_id', 'app_account_id') ORDER BY p.proname`;
    expect(rows).toEqual([
      { proname: "app_account_id", provolatile: "s", prosecdef: false, rettype: "uuid" },
      { proname: "app_workspace_id", provolatile: "s", prosecdef: false, rettype: "uuid" },
    ]);
  });

  it("make both functions NULL when the setting is unset or empty, so a query outside withTenant matches nothing", async () => {
    const unset = await db`SELECT app_workspace_id() AS workspace, app_account_id() AS account`;
    expect(unset[0]).toEqual({ workspace: null, account: null });
    const empty = await db.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', '', true), set_config('app.account_id', '', true)`;
      return tx`SELECT app_workspace_id() AS workspace, app_account_id() AS account`;
    });
    expect(empty[0]).toEqual({ workspace: null, account: null });
  });

  it("return the transaction-local settings, each from its own setting", async () => {
    const rows = await db.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true), set_config('app.account_id', ${ACCOUNT}, true)`;
      return tx`SELECT app_workspace_id() AS workspace, app_account_id() AS account`;
    });
    expect(rows[0]).toEqual({ workspace: WORKSPACE, account: ACCOUNT });
    const after = await db`SELECT app_workspace_id() AS workspace`;
    expect(after[0]).toEqual({ workspace: null });
  });

  it("can have their SQL files applied a second time: the files are declarative", async () => {
    // A migration that creates a table cannot run twice; the files of src/sql, which every
    // migration that changes them carries whole, are what must.
    for (const name of readdirSync(SQL_SOURCES).filter((file) => file.endsWith(".sql")).sort()) {
      await db.begin(async (tx) => {
        for (const statement of splitStatements(readFileSync(new URL(name, SQL_SOURCES), "utf8"))) {
          await tx.unsafe(statement);
        }
      });
    }
    const rows = await db`SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('citext', 'pg_trgm', 'btree_gin')`;
    expect(rows[0]).toEqual({ n: 3 });
  });

  it("keep an index on an existing table out of any transaction, which PostgreSQL would refuse", async () => {
    await db.unsafe("CREATE TABLE concurrent_probe (a text)");
    const { transactional, concurrent } = rewriteIndexesConcurrently(
      'CREATE INDEX "concurrent_probe_a_idx" ON "concurrent_probe" USING btree ("a");',
      new Set(["public.concurrent_probe"]),
    );
    expect(transactional).toEqual([]);
    const [statement] = concurrent;
    expect(statement).toContain("CREATE INDEX CONCURRENTLY");

    await expect(db.begin((tx) => tx.unsafe(statement ?? ""))).rejects.toMatchObject({ code: "25001" });
    await db.unsafe(statement ?? "");
    const rows = await db`
      SELECT indisvalid FROM pg_index WHERE indexrelid = 'concurrent_probe_a_idx'::regclass`;
    expect(rows[0]).toEqual({ indisvalid: true });
  });
});
