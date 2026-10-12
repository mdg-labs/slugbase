import { CE_CHAIN, MigrationError } from "@slugbase/db";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { PGBOSS_SCHEMA } from "../../src/migrate/pgboss.ts";
import { scratchChains, urlOf, useMigratableDatabase } from "./support.ts";

// The migration `migrate` and MIGRATE_ON_START both run (doc 05 sections 5.3 and
// 5.5): the CE chain, the pg-boss schema, then the additional chains, as
// slugbase_migrator, under one advisory lock per chain.

const database = useMigratableDatabase();
const chains = scratchChains();

afterAll(() => {
  chains.remove();
});

const migratorUrl = (): string => urlOf(database().owner);

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return database().owner.unsafe<Record<string, unknown>[]>(sql);
}

describe("runMigrations", () => {
  it("installs the pg-boss schema as slugbase_owner after the CE chain, and does nothing the second time", async () => {
    const first = await runMigrations({ url: migratorUrl() });
    expect(first.applied.map((step) => step.chain)).toEqual([PGBOSS_SCHEMA]);

    const version = await rows(`SELECT version::int AS version FROM ${PGBOSS_SCHEMA}.version`);
    expect(version).toHaveLength(1);
    const owners = await rows(`
      SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE relnamespace = '${PGBOSS_SCHEMA}'::regnamespace AND relkind IN ('r', 'p')`);
    expect(owners).toEqual([{ owner: "slugbase_owner" }]);
    // The worker connects as slugbase_app, which reads and writes what the owner created in the schema.
    const queues = await database().app`SELECT count(*)::int AS n FROM pgboss.queue`;
    expect(queues[0]?.["n"]).toBeGreaterThanOrEqual(0);
    await database().app.unsafe(`SELECT pgboss.job_now()`);

    const second = await runMigrations({ url: migratorUrl() });
    expect(second.applied).toEqual([]);
  });

  it("applies the additional chains after the pg-boss schema and records each once", async () => {
    const extra = chains.chain("extra", ["CREATE TABLE public.extra_one (id int);", "CREATE TABLE public.extra_two (id int);"]);
    const result = await runMigrations({ url: migratorUrl(), chains: [extra] });
    expect(result.applied).toEqual([
      { chain: "extra", tag: "0000_extra" },
      { chain: "extra", tag: "0001_extra" },
    ]);
    expect(await rows(`SELECT count(*)::int AS n FROM drizzle.migrations_extra`)).toEqual([{ n: 2 }]);
    expect((await runMigrations({ url: migratorUrl(), chains: [extra] })).applied).toEqual([]);
  });

  it("stops at a failed migration, leaves its bookkeeping unchanged and names no connection string", async () => {
    const broken = chains.chain("broken", ["CREATE TABLE public.broken_ok (id int);", "SELECT * FROM public.table_that_does_not_exist;"]);
    const url = migratorUrl();
    const failure = await runMigrations({ url, chains: [broken] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationError);
    const message = (failure as MigrationError).message;
    expect(message).toContain("0001_broken");
    expect(message).not.toContain(url);
    expect(message).not.toContain(String(database().owner.options.pass));
    // The first migration of the chain was recorded with its own transaction; the failed one left no row and no table.
    expect(await rows(`SELECT hash FROM drizzle.migrations_broken`)).toHaveLength(1);
    expect(await rows(`SELECT to_regclass('public.broken_ok') IS NOT NULL AS present`)).toEqual([{ present: true }]);
  });

  it("refuses a pg-boss schema newer than the build, and names no password", async () => {
    await database().owner.unsafe(`UPDATE ${PGBOSS_SCHEMA}.version SET version = 1000000`);
    const url = migratorUrl();
    const failure = await runMigrations({ url }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).message).toMatch(/pg-boss schema is at version 1000000, which is newer than version \d+/);
    expect((failure as MigrationError).message).not.toContain(String(database().owner.options.pass));
  });

  it("rejects without the connection string when the database cannot be reached", async () => {
    const url = new URL(migratorUrl());
    url.port = "1";
    const failure = await runMigrations({ url: url.href }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).message).not.toContain(url.href);
    expect((failure as MigrationError).message).not.toContain(String(database().owner.options.pass));
    expect(CE_CHAIN.name).toBe("core");
  });
});
