import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRateLimitStore, type RateLimitStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

// Token buckets (doc 01 section 8.2, doc 05 sections 2.10 and 3.3, doc 10 T9):
// the unlogged table nobody but slugbase_system can touch, and the
// sys_rate_limit_take function that updates a bucket in one statement.

const HOOK_TIMEOUT_MS = 300_000;
const FUNCTION = "public.sys_rate_limit_take(text, double precision, double precision, double precision)";

const server = new URL(
  process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

let db: TestDatabase;
let store: RateLimitStore;
// The table has forced row-level security and no policy, so not even its owner
// reads it; the fixtures and the assertions on its rows connect as the
// server's own superuser, which stands for slugbase_system here.
let root: postgres.Sql;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

let keyNumber = 0;
const freshKey = (): string => `test:${String(++keyNumber)}`;

beforeAll(async () => {
  db = await createTestDatabase();
  // A pool smaller than the number of concurrent takes of the tests below: the
  // takes queue for a connection, they do not each open one.
  store = createRateLimitStore({ url: appUrl(db), poolSize: 8 });
  root = postgres({
    host: server.hostname,
    port: Number(server.port === "" ? 5432 : server.port),
    database: db.name,
    username: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
    max: 2,
    onnotice: () => undefined,
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await root.end({ timeout: 5 });
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

describe("the rate_limit_buckets table", () => {
  it("is unlogged, with a text key, real tokens and a timestamptz updated_at", async () => {
    const table = await db.owner<{ persistence: string }[]>`
      SELECT relpersistence AS persistence FROM pg_class WHERE oid = 'public.rate_limit_buckets'::regclass`;
    expect(table[0]?.persistence).toBe("u");
    const columns = await db.owner<{ name: string; type: string; primary: boolean }[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             coalesce(i.indisprimary, false) AS primary
      FROM pg_attribute a
      LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
      WHERE a.attrelid = 'public.rate_limit_buckets'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    expect([...columns]).toEqual([
      { name: "key", type: "text", primary: true },
      { name: "tokens", type: "real", primary: false },
      { name: "updated_at", type: "timestamp with time zone", primary: false },
    ]);
  });

  it("has row-level security enabled and forced, and no policy", async () => {
    const rows = await db.owner<{ enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c WHERE c.oid = 'public.rate_limit_buckets'::regclass`;
    expect([...rows]).toEqual([{ enabled: true, forced: true, policies: 0 }]);
  });

  it("gives slugbase_app no privilege on it, and PUBLIC none", async () => {
    const rows = await db.owner<{ privilege: string; app: boolean }[]>`
      SELECT p AS privilege, has_table_privilege('slugbase_app', 'public.rate_limit_buckets', p) AS app
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p`;
    expect(rows.filter((row) => row.app)).toEqual([]);
    const publicGrants = await db.owner<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = 'public.rate_limit_buckets'::regclass AND a.grantee = 0`;
    expect(publicGrants[0]?.count).toBe(0);
    await expect(db.app.unsafe("SELECT * FROM public.rate_limit_buckets")).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe("DELETE FROM public.rate_limit_buckets")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the sys_rate_limit_take function", () => {
  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path, in the registry", async () => {
    const rows = await db.owner<{ definer: boolean; owner: string; config: string[]; language: string }[]>`
      SELECT prosecdef AS definer, pg_get_userbyid(proowner) AS owner, proconfig AS config, l.lanname AS language
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = ${FUNCTION}::regprocedure`;
    expect([...rows]).toEqual([
      { definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], language: "plpgsql" },
    ]);
    expect(systemOperations).toContain("sys_rate_limit_take");
  });

  it("lets slugbase_app run it and nobody else but the owner", async () => {
    const rows = await db.owner<{ app: boolean; public: boolean }[]>`
      SELECT has_function_privilege('slugbase_app', ${FUNCTION}::regprocedure, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE p.oid = ${FUNCTION}::regprocedure AND a.grantee = 0) AS public`;
    expect([...rows]).toEqual([{ app: true, public: false }]);
  });

  it("refuses arguments no bucket can be built from, and writes nothing for them", async () => {
    const key = freshKey();
    const call = (capacity: string, refill: string, cost: string) =>
      db.app.unsafe(`SELECT * FROM sys_rate_limit_take('${key}', ${capacity}, ${refill}, ${cost})`);
    await expect(call("0", "1", "1")).rejects.toMatchObject({ code: "22023" });
    await expect(call("-1", "1", "1")).rejects.toMatchObject({ code: "22023" });
    await expect(call("10", "0", "1")).rejects.toMatchObject({ code: "22023" });
    await expect(call("10", "1", "0")).rejects.toMatchObject({ code: "22023" });
    await expect(call("10", "1", "-1")).rejects.toMatchObject({ code: "22023" });
    await expect(call("'NaN'", "1", "1")).rejects.toMatchObject({ code: "22023" });
    await expect(call("10", "'Infinity'", "1")).rejects.toMatchObject({ code: "22023" });
    await expect(call("10", "1", "'NaN'")).rejects.toMatchObject({ code: "22023" });
    await expect(call("NULL", "1", "1")).rejects.toMatchObject({ code: "22023" });
    await expect(db.app.unsafe(`SELECT * FROM sys_rate_limit_take(NULL, 10, 1, 1)`)).rejects.toMatchObject({ code: "22023" });
    const rows = await root<{ count: number }[]>`SELECT count(*)::int AS count FROM rate_limit_buckets WHERE key = ${key}`;
    expect(rows[0]?.count).toBe(0);
  });
});

describe("taking tokens", () => {
  it("consumes tokens one take at a time and then refuses, with the delay until the next token", async () => {
    const key = freshKey();
    const take = () => store.take({ key, capacity: 3, refillPerSecond: 0.5, cost: 1 });
    const results = [await take(), await take(), await take()];
    expect(results.map((result) => result.allowed)).toEqual([true, true, true]);
    expect(results.map((result) => Math.round(result.remaining))).toEqual([2, 1, 0]);
    expect(results.map((result) => result.retryAfterSeconds)).toEqual([0, 0, 0]);

    const refused = await take();
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBeLessThan(1);
    // One token at 0.5 a second is two seconds away, less what refilled since the third take.
    expect(refused.retryAfterSeconds).toBeGreaterThan(1.5);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(2);
  });

  it("does not spend tokens on a refused take", async () => {
    const key = freshKey();
    await store.take({ key, capacity: 2, refillPerSecond: 0.001, cost: 2 });
    for (let i = 0; i < 5; i += 1) {
      expect((await store.take({ key, capacity: 2, refillPerSecond: 0.001, cost: 1 })).allowed).toBe(false);
    }
    const row = await root<{ tokens: number }[]>`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`;
    expect(row[0]?.tokens).toBeLessThan(0.1);
    expect(row[0]?.tokens).toBeGreaterThanOrEqual(0);
  });

  it("refills with the time the database clock says has passed, up to the capacity", async () => {
    const key = freshKey();
    const take = (cost: number) => store.take({ key, capacity: 1000, refillPerSecond: 100, cost });
    expect((await take(1000)).allowed).toBe(true);
    // A full refill takes 10 s at this rate, far more than a loaded machine can put between two takes.
    expect((await take(1000)).allowed).toBe(false);

    const before = Date.now();
    await sleep(300);
    const next = await take(1);
    const elapsedSeconds = (Date.now() - before) / 1000;
    expect(next.allowed).toBe(true);
    // At least what the 300 ms slept refilled, at most what the wall time allows; one token was taken.
    expect(next.remaining + 1).toBeGreaterThanOrEqual(100 * 0.3 - 1);
    expect(next.remaining + 1).toBeLessThanOrEqual(100 * (elapsedSeconds + 0.5));

    const small = freshKey();
    const first = await store.take({ key: small, capacity: 2, refillPerSecond: 50, cost: 2 });
    expect(first.allowed).toBe(true);
    await sleep(250);
    const capped = await store.take({ key: small, capacity: 2, refillPerSecond: 50, cost: 1 });
    expect(capped.allowed).toBe(true);
    // 12 tokens worth of time passed; the bucket holds 2, so one is left.
    expect(capped.remaining).toBeCloseTo(1, 5);
  });

  it("keeps independent keys independent", async () => {
    const a = freshKey();
    const b = freshKey();
    const spend = (key: string) => store.take({ key, capacity: 2, refillPerSecond: 0.001, cost: 1 });
    expect((await spend(a)).allowed).toBe(true);
    expect((await spend(a)).allowed).toBe(true);
    expect((await spend(a)).allowed).toBe(false);
    const other = await spend(b);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBeCloseTo(1, 5);
  });

  it("refuses a cost above the capacity, also on a full bucket, and leaves the bucket as it was", async () => {
    const key = freshKey();
    const refused = await store.take({ key, capacity: 5, refillPerSecond: 1, cost: 6 });
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBeCloseTo(5, 5);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    const created = await root<{ count: number }[]>`SELECT count(*)::int AS count FROM rate_limit_buckets WHERE key = ${key}`;
    expect(created[0]?.count).toBe(0);

    const exact = await store.take({ key, capacity: 5, refillPerSecond: 0.001, cost: 5 });
    expect(exact.allowed).toBe(true);
    expect(exact.remaining).toBeCloseTo(0, 5);
    const again = await store.take({ key, capacity: 5, refillPerSecond: 0.001, cost: 6 });
    expect(again.allowed).toBe(false);
    const row = await root<{ tokens: number }[]>`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`;
    expect(row[0]?.tokens).toBeLessThan(0.1);
  });

  it("takes a cost larger than one", async () => {
    const key = freshKey();
    const take = (cost: number) => store.take({ key, capacity: 10, refillPerSecond: 0.001, cost });
    expect((await take(4)).remaining).toBeCloseTo(6, 3);
    expect((await take(7)).allowed).toBe(false);
    expect((await take(6)).allowed).toBe(true);
  });

  it("is not reachable by slugbase_app except through the function", async () => {
    await expect(
      db.app.unsafe(`INSERT INTO rate_limit_buckets (key, tokens, updated_at) VALUES ('x', 1000, now())`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

// T9: a limit that a burst can step around is no limit. 50 callers race for a
// bucket of 10 tokens, and exactly 10 may win.
describe("concurrent takes (T9)", () => {
  const CALLERS = 50;
  const CAPACITY = 10;

  it("allow exactly the capacity when 50 callers race for it", async () => {
    const key = freshKey();
    const results = await Promise.all(
      Array.from({ length: CALLERS }, () => store.take({ key, capacity: CAPACITY, refillPerSecond: 0.001, cost: 1 })),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(CAPACITY);
    expect(results.filter((result) => !result.allowed)).toHaveLength(CALLERS - CAPACITY);
    const row = await root<{ tokens: number }[]>`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`;
    expect(row[0]?.tokens).toBeLessThan(0.1);
    expect(row[0]?.tokens).toBeGreaterThanOrEqual(0);
  });

  it("allow exactly the capacity when the bucket already exists", async () => {
    const key = freshKey();
    await store.take({ key, capacity: CAPACITY, refillPerSecond: 0.001, cost: 0.5 });
    await root`UPDATE rate_limit_buckets SET tokens = ${CAPACITY} WHERE key = ${key}`;
    const results = await Promise.all(
      Array.from({ length: CALLERS }, () => store.take({ key, capacity: CAPACITY, refillPerSecond: 0.001, cost: 1 })),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(CAPACITY);
  });

  // A refused take reports the bucket as the refusal found it: below the cost,
  // with a delay above 0, however many callers were queued on the row lock.
  it("report every refused caller a balance below the cost and a delay above 0", async () => {
    const existing = freshKey();
    await store.take({ key: existing, capacity: CAPACITY, refillPerSecond: 0.001, cost: 0.5 });
    await root`UPDATE rate_limit_buckets SET tokens = ${CAPACITY} WHERE key = ${existing}`;
    for (const key of [freshKey(), existing]) {
      for (let round = 0; round < 3; round += 1) {
        const roundKey = round === 0 ? key : freshKey();
        const results = await Promise.all(
          Array.from({ length: CALLERS }, () =>
            store.take({ key: roundKey, capacity: CAPACITY, refillPerSecond: 0.001, cost: 1 }),
          ),
        );
        const refused = results.filter((result) => !result.allowed);
        expect(refused).toHaveLength(CALLERS - CAPACITY);
        for (const result of refused) {
          expect(result.remaining).toBeLessThan(1);
          expect(result.retryAfterSeconds).toBeGreaterThan(0);
        }
      }
    }
  });

  // The same race against a read-modify-write in separate statements, the way
  // a limiter written without the single statement would do it. Every caller
  // reads before any writes, so all of them see tokens and the burst gets
  // through: the assertion of the test above fails for this implementation.
  it("lets a burst through a read-modify-write, which the test above would catch", async () => {
    const key = freshKey();
    await root`INSERT INTO rate_limit_buckets (key, tokens, updated_at) VALUES (${key}, ${CAPACITY}, now())`;
    const reader: postgres.Sql = root;
    let read = 0;
    let release: () => void = () => undefined;
    const allRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const naiveTake = async (): Promise<boolean> => {
      const rows = await reader<{ tokens: number }[]>`SELECT tokens FROM rate_limit_buckets WHERE key = ${key}`;
      read += 1;
      if (read === CALLERS) {
        release();
      }
      await allRead;
      const tokens = rows[0]?.tokens ?? 0;
      if (tokens < 1) {
        return false;
      }
      await reader`UPDATE rate_limit_buckets SET tokens = ${tokens - 1} WHERE key = ${key}`;
      return true;
    };
    const results = await Promise.all(Array.from({ length: CALLERS }, naiveTake));
    expect(results.filter(Boolean).length).toBeGreaterThan(CAPACITY);
  });
});
