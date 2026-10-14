import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRetentionStore, type RetentionStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// Retention (doc 05 section 6): sys_retention_purge() deletes what has outlived
// its retention, a batch of 5 000 rows per table per call, and answers how many
// it deleted per table. The first rule is the session rule.

const HOOK_TIMEOUT_MS = 300_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BATCH = 5_000;
const FUNCTION = "public.sys_retention_purge()";

let db: TestDatabase;
let store: RetentionStore;

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

beforeAll(async () => {
  db = await createTestDatabase();
  store = createRetentionStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `retention${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface SeedSession {
  readonly accountId: string;
  /** Offsets from now in milliseconds; negative is in the past. */
  readonly expiresIn: number;
  readonly absoluteExpiresIn: number;
  readonly level?: "partial" | "full";
}

async function seedSession(session: SeedSession): Promise<string> {
  const id = freshId();
  const { hash } = freshToken();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at)
      VALUES (${id}, ${hash}, ${session.accountId}, ${session.level ?? "full"}, false,
              now() - interval '200 days', now() - interval '1 day',
              now() + ${session.expiresIn} * interval '1 millisecond',
              now() + ${session.absoluteExpiresIn} * interval '1 millisecond')`;
  });
  return id;
}

async function remainingIds(): Promise<string[]> {
  return (await sessionRows(db)).map((row) => row.id).sort();
}

async function clearSessions(): Promise<void> {
  await asSystem(db, (tx) => tx`DELETE FROM sessions`);
}

describe("purging expired sessions", () => {
  it("deletes sessions past their sliding or absolute expiry, keeps the live ones, and counts what it deleted", async () => {
    await clearSessions();
    const mine = await account();
    const other = await account();
    await seedSession({ accountId: mine, expiresIn: -HOUR_MS, absoluteExpiresIn: 100 * DAY_MS });
    await seedSession({ accountId: mine, expiresIn: 10 * DAY_MS, absoluteExpiresIn: -HOUR_MS });
    await seedSession({ accountId: other, expiresIn: -2 * DAY_MS, absoluteExpiresIn: -DAY_MS });
    await seedSession({ accountId: other, expiresIn: -1000, absoluteExpiresIn: DAY_MS, level: "partial" });
    const live = await seedSession({ accountId: mine, expiresIn: 10 * DAY_MS, absoluteExpiresIn: 100 * DAY_MS });
    const otherLive = await seedSession({ accountId: other, expiresIn: HOUR_MS, absoluteExpiresIn: 100 * DAY_MS });
    const justLive = await seedSession({ accountId: other, expiresIn: 60_000, absoluteExpiresIn: 60_000 });

    const counts = await store.purge();

    expect(counts).toEqual([{ table: "sessions", deleted: 4 }]);
    expect(await remainingIds()).toEqual([live, otherLive, justLive].sort());
  });

  it("deletes nothing and says so when no session has expired", async () => {
    await clearSessions();
    const owner = await account();
    const live = await seedSession({ accountId: owner, expiresIn: DAY_MS, absoluteExpiresIn: DAY_MS });

    expect(await store.purge()).toEqual([{ table: "sessions", deleted: 0 }]);
    expect(await remainingIds()).toEqual([live]);
  });

  it("leaves the accounts alone", async () => {
    await clearSessions();
    const owner = await account();
    await seedSession({ accountId: owner, expiresIn: -HOUR_MS, absoluteExpiresIn: -HOUR_MS });
    const before = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts`;

    await store.purge();

    const after = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts`;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it("deletes one batch of 5 000 per call and finishes the rest on the next calls", async () => {
    await clearSessions();
    const owner = await account();
    const live = await seedSession({ accountId: owner, expiresIn: DAY_MS, absoluteExpiresIn: DAY_MS });
    const extra = 123;
    await asSystem(db, async (tx) => {
      await tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at)
        SELECT gen_random_uuid(), decode(md5('a' || n::text) || md5('b' || n::text), 'hex'), ${owner}, 'full', false,
               now() - interval '200 days', now() - interval '1 day',
               now() - interval '1 hour', now() + interval '10 days'
        FROM generate_series(1, ${2 * BATCH + extra}) AS n`;
    });

    expect(await store.purge()).toEqual([{ table: "sessions", deleted: BATCH }]);
    expect((await sessionRows(db)).length).toBe(BATCH + extra + 1);
    expect(await store.purge()).toEqual([{ table: "sessions", deleted: BATCH }]);
    expect(await store.purge()).toEqual([{ table: "sessions", deleted: extra }]);
    expect(await store.purge()).toEqual([{ table: "sessions", deleted: 0 }]);
    expect(await remainingIds()).toEqual([live]);
  }, HOOK_TIMEOUT_MS);

  it("does not wait for a session a concurrent request holds and deletes it on a later call", async () => {
    await clearSessions();
    const owner = await account();
    const locked = await seedSession({ accountId: owner, expiresIn: -HOUR_MS, absoluteExpiresIn: DAY_MS });
    await seedSession({ accountId: owner, expiresIn: -HOUR_MS, absoluteExpiresIn: DAY_MS });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = asSystem(db, async (tx) => {
      await tx`SELECT id FROM sessions WHERE id = ${locked} FOR UPDATE`;
      acquired();
      await held;
    });
    await lockTaken;

    const counts = await store.purge();
    release();
    await holder;

    expect(counts).toEqual([{ table: "sessions", deleted: 1 }]);
    expect(await remainingIds()).toEqual([locked]);
    expect(await store.purge()).toEqual([{ table: "sessions", deleted: 1 }]);
    expect(await remainingIds()).toEqual([]);
  });
});

describe("sys_retention_purge()", () => {
  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path, in the registry", async () => {
    const rows = await db.owner<{ definer: boolean; owner: string; config: string[]; language: string }[]>`
      SELECT prosecdef AS definer, pg_get_userbyid(proowner) AS owner, proconfig AS config, l.lanname AS language
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = ${FUNCTION}::regprocedure`;
    expect([...rows]).toEqual([
      { definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], language: "plpgsql" },
    ]);
    expect(systemOperations).toContain("sys_retention_purge");
  });

  it("lets slugbase_app run it and nobody else but the owner", async () => {
    const rows = await db.owner<{ app: boolean; public: boolean }[]>`
      SELECT has_function_privilege('slugbase_app', ${FUNCTION}::regprocedure, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE p.oid = ${FUNCTION}::regprocedure AND a.grantee = 0) AS public`;
    expect([...rows]).toEqual([{ app: true, public: false }]);
  });

  it("takes no argument, so a caller cannot widen what it deletes", async () => {
    const rows = await db.owner<{ args: number }[]>`
      SELECT pronargs::int AS args FROM pg_proc WHERE oid = ${FUNCTION}::regprocedure`;
    expect([...rows]).toEqual([{ args: 0 }]);
  });

  it("gives slugbase_app no privilege on sessions: the purge is the only way it removes one", async () => {
    await expect(db.app.unsafe("DELETE FROM public.sessions")).rejects.toMatchObject({ code: "42501" });
  });
});
