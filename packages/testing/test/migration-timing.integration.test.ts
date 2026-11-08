import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CE_CHAIN, type MigrationChain } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/db.ts";
import {
  LOCK_LIMIT_MS,
  MigrationLockError,
  assertLocksWithinLimit,
  chainTags,
  isNonTransactional,
  lockViolations,
  prepareMigrationInstance,
  serverConnection,
  timeMigrations,
} from "../src/perf/index.ts";
import { runSeedScript } from "../src/seed/index.ts";

// The migration timing of doc 08 section 5.4 against throwaway databases of the test harness: a fixture chain that rewrites a table of
// 50 000 rows under ACCESS EXCLUSIVE fails the check and a fast one passes, and the instance the real run measures on is built at the
// level of a release, raised to where the large instance can be written, and takes the rest of the CE chain.

const TEST_TIMEOUT_MS = 300_000;
const harnessUrl = process.env["SLUGBASE_TEST_PG_URL"];
const serverUrl = harnessUrl ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const path = process.env["PATH"] ?? "";
const CE_TAGS = chainTags(CE_CHAIN);

const longLock: MigrationChain = {
  name: "long_lock",
  folder: fileURLToPath(new URL("./fixtures/long-lock/", import.meta.url)),
  bookkeepingTable: "migrations_long_lock",
};
const [FAST = "", SLOW = "", CONCURRENT = ""] = chainTags(longLock);

describe("a fixture chain applied after the CE chain to a table of 50 000 rows", () => {
  it("fails the migration that rewrites the table under ACCESS EXCLUSIVE and passes the fast schema-only one", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withTestDatabase(async (db) => {
      await db.owner.unsafe("CREATE TABLE perf_rows AS SELECT g::int AS n, md5(g::text) AS payload FROM generate_series(1, 50000) AS g");
      const rows = await db.owner.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM perf_rows");
      expect(rows[0]?.n).toBe(50_000);
      const connection = serverConnection(serverUrl, db.name);

      const timings = await timeMigrations({
        migratorUrl: migratorUrlFor(connection),
        connection,
        chains: [longLock],
        after: { chain: CE_CHAIN.name, tag: CE_TAGS.at(-1) ?? "" },
        path,
      });

      expect(timings.map((timing) => timing.tag)).toEqual([FAST, SLOW, CONCURRENT]);
      const [fast, slow, concurrent] = timings;
      expect(fast?.nonTransactional).toBe(false);
      expect(fast?.lock === undefined || fast.lock.heldMs < LOCK_LIMIT_MS).toBe(true);
      expect(slow?.lock?.relation).toBe("public.perf_rows");
      expect(slow?.lock?.heldMs).toBeGreaterThan(LOCK_LIMIT_MS);
      expect(slow?.wallMs).toBeGreaterThanOrEqual(1_500);
      expect(concurrent?.nonTransactional).toBe(true);
      expect(concurrent?.lock).toBeUndefined();
      expect(timings.every((timing) => timing.file === `${timing.tag}.sql` && timing.chain === "long_lock")).toBe(true);

      expect(lockViolations(timings).map((timing) => timing.file)).toEqual([`${SLOW}.sql`]);
      expect(() => {
        assertLocksWithinLimit(timings);
      }).toThrow(MigrationLockError);
      expect(() => {
        assertLocksWithinLimit(timings);
      }).toThrow(new RegExp(`${SLOW}\\.sql .*public\\.perf_rows`, "u"));
      expect(() => {
        assertLocksWithinLimit(timings.filter((timing) => timing.tag !== SLOW));
      }).not.toThrow();

      const indexed = await db.owner.unsafe<{ valid: boolean }[]>("SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'perf_rows_n_idx'::regclass");
      expect(indexed[0]?.valid).toBe(true);
    });
  });

  it("refuses to time a migration when the call applied more than that one", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withTestDatabase(async (db) => {
      await db.owner.unsafe("CREATE TABLE perf_rows AS SELECT g::int AS n FROM generate_series(1, 10) AS g");
      const connection = serverConnection(serverUrl, db.name);
      // `after` names the chain's first migration, which has not been applied, so the call for the second applies both of them.
      await expect(
        timeMigrations({
          migratorUrl: migratorUrlFor(connection),
          connection,
          chains: [longLock],
          after: { chain: "long_lock", tag: FAST },
          path,
        }),
      ).rejects.toThrow(new RegExp(`${SLOW}\\.sql applied ${FAST}, ${SLOW}: the database was not at the level before it`, "u"));
    });
  });

  it("refuses an `after` that no chain of the run has", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withTestDatabase(async (db) => {
      const connection = serverConnection(serverUrl, db.name);
      await expect(
        timeMigrations({ migratorUrl: migratorUrlFor(connection), connection, after: { chain: "core", tag: "20300101000009_absent" }, path }),
      ).rejects.toThrow(/is not in the chains of this run/u);
    });
  });
});

function migratorUrlFor(connection: ReturnType<typeof serverConnection>): string {
  return `postgres://slugbase_migrator:slugbase_migrator_dev_only@${connection.host}:${String(connection.port)}/${connection.database}`;
}

describe("the instance of the real run", () => {
  const options = { serverUrl, path, harnessUrl, bookmarks: 600, workspaces: 6 } as const;

  async function recorded(connection: ReturnType<typeof serverConnection>): Promise<number> {
    return Number((await runSeedScript(connection, "SELECT count(*) FROM drizzle.migrations_core;", { path, capture: true })).trim());
  }

  it("is built at the release's level, raised to where the seed can be written, and takes every later CE migration", { timeout: TEST_TIMEOUT_MS }, async () => {
    const released = CE_TAGS.slice(0, 3);
    const prepared = await prepareMigrationInstance({ ...options, released });
    try {
      expect(prepared.baseline.releaseLevel).toBe(released.at(-1));
      expect(prepared.baseline.raised).toBe(true);
      expect(prepared.baseline.missingAtRelease).toContain("bookmarks.url");
      expect(prepared.baseline.missingAtRelease).toContain("sys_create_account/6");
      const level = CE_TAGS.indexOf(prepared.baseline.level);
      expect(level).toBeGreaterThan(2);
      expect(level).toBeLessThan(CE_TAGS.length - 1);
      expect(await recorded(prepared.connection)).toBe(level + 1);
      const bookmarks = prepared.instance.workspaces.reduce((sum, workspace) => sum + workspace.bookmarks.length, 0);
      expect(prepared.counts).toMatchObject({ database: prepared.databaseName, accounts: prepared.instance.accounts.length, workspaces: prepared.instance.workspaces.length, bookmarks });

      const timings = await timeMigrations({
        migratorUrl: prepared.migratorUrl,
        connection: prepared.connection,
        after: { chain: CE_CHAIN.name, tag: prepared.baseline.level },
        path,
      });

      expect(timings.map((timing) => timing.tag)).toEqual(CE_TAGS.slice(level + 1));
      expect(timings.every((timing) => timing.chain === CE_CHAIN.name && timing.wallMs > 0)).toBe(true);
      // A concurrent index build of the CE chain is a non-transactional step and is not judged on a lock.
      const marked = (tag: string): boolean => isNonTransactional(readFileSync(join(CE_CHAIN.folder, `${tag}.sql`), "utf8"));
      expect(timings.map((timing) => timing.nonTransactional)).toEqual(CE_TAGS.slice(level + 1).map(marked));
      expect(timings.some((timing) => timing.nonTransactional)).toBe(true);
      expect(timings.every((timing) => !timing.nonTransactional || timing.lock === undefined)).toBe(true);
      expect(await recorded(prepared.connection)).toBe(CE_TAGS.length);
    } finally {
      await prepared.drop();
    }
  });

  it("keeps the release's level when the seed can already be written there, and has nothing to time", { timeout: TEST_TIMEOUT_MS }, async () => {
    const prepared = await prepareMigrationInstance({ ...options, released: CE_TAGS });
    try {
      expect(prepared.baseline).toEqual({ releaseLevel: CE_TAGS.at(-1), level: CE_TAGS.at(-1), raised: false, missingAtRelease: [] });
      const timings = await timeMigrations({
        migratorUrl: prepared.migratorUrl,
        connection: prepared.connection,
        after: { chain: CE_CHAIN.name, tag: CE_TAGS.at(-1) ?? "" },
        path,
      });
      expect(timings).toEqual([]);
    } finally {
      await prepared.drop();
    }
  });

  it("drops its database when it cannot be built", { timeout: TEST_TIMEOUT_MS }, async () => {
    let name = "";
    await expect(
      prepareMigrationInstance({
        ...options,
        released: CE_TAGS.slice(0, 3),
        onDatabase: (created) => {
          name = created;
          throw new Error("stop after the database exists");
        },
      }),
    ).rejects.toThrow(/stop after the database exists/u);
    expect(name).toMatch(/^test_[0-9a-f]{16}$/u);
    const left = await runSeedScript(serverConnection(serverUrl), `SELECT count(*) FROM pg_database WHERE datname = '${name}';`, { path, capture: true });
    expect(left.trim()).toBe("0");
  });
});
