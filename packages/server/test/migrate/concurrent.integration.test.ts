import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { PGBOSS_SCHEMA } from "../../src/migrate/pgboss.ts";
import { scratchChains, urlOf, useMigratableDatabase } from "./support.ts";

// Several servers started together against one database (doc 05 section 5.3):
// one installs the pg-boss schema and applies each chain, the others wait for
// the lock and find nothing left to do.

const database = useMigratableDatabase();
const chains = scratchChains();

afterAll(() => {
  chains.remove();
});

describe("migrations started together", () => {
  it("install the pg-boss schema and apply a chain once, whichever of them gets there first", async () => {
    const slow = chains.chain("slow", ["SELECT pg_sleep(1); CREATE TABLE public.slow_one (id int);"]);
    const url = urlOf(database().owner);
    const runs = await Promise.all([1, 2, 3].map(() => runMigrations({ url, chains: [slow] })));
    const steps = runs.flatMap((run) => run.applied);
    expect(steps.filter((step) => step.chain === PGBOSS_SCHEMA)).toHaveLength(1);
    expect(steps.filter((step) => step.chain === "slow")).toEqual([{ chain: "slow", tag: "0000_slow" }]);
    const bookkeeping = await database().owner.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM drizzle.migrations_slow`);
    expect(bookkeeping).toEqual([{ n: 1 }]);
    const versions = await database().owner.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${PGBOSS_SCHEMA}.version`);
    expect(versions).toEqual([{ n: 1 }]);
  });
});
