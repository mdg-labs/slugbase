import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdempotencyBusyError, idempotencyRepository, type IdempotencyOutcome } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle } from "../src/tenant.ts";
import { freshId, seedAccount } from "./support/auth-fixture.ts";

// The idempotency keys of an account (doc 05 section 2.10, doc 04 section 6.3, doc 10 T1). The failure scenarios:
// two requests with one key that both run; a key of one account that another account replays, conflicts with
// or sees; a stored response that outlives its 24 hours; a request that waits on a held key without end; and a
// key left behind by a request that rolled back. The RLS-only checks run statements as slugbase_app with the
// settings of an account and no repository.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 30_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const HOUR_MS = 3_600_000;
const LOCK_WAIT_MS = 5_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `idempotency${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

const hash = (text: string): Buffer => createHash("sha256").update(text).digest();

function inTenant<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "idempotency-test" }, work);
}

const claim = (accountId: string, key: string, operation = "createInvitation", request = "request"): Promise<IdempotencyOutcome> =>
  inTenant(accountId, (tx) => idempotencyRepository(tx).claim({ key, operation, requestHash: hash(request) }));

/** Claims the key, stores a response and commits. */
function run(accountId: string, key: string, body: unknown = { ok: true }, request = "request"): Promise<IdempotencyOutcome> {
  return inTenant(accountId, async (tx) => {
    const repository = idempotencyRepository(tx);
    const outcome = await repository.claim({ key, operation: "createInvitation", requestHash: hash(request) });
    if (outcome.kind === "claimed") {
      await repository.complete(key, { status: 201, body });
    }
    return outcome;
  });
}

async function rowsOf(key: string): Promise<{ account_id: string; status: string; response_status: number | null; expires_at: Date; created_at: Date }[]> {
  const rows = await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string; status: string; response_status: number | null; expires_at: Date; created_at: Date }[]>`
      SELECT account_id, status, response_status, expires_at, created_at FROM idempotency_keys WHERE key = ${key} ORDER BY account_id`;
  });
  return [...rows];
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

describe("claiming and replaying a key", { timeout: TEST_TIMEOUT_MS }, () => {
  it("claims a new key, stores the response and answers it to the same request afterwards", async () => {
    const owner = await account();
    const key = freshId();

    expect(await run(owner, key, { id: "one", n: 1 })).toEqual({ kind: "claimed" });
    expect(await claim(owner, key)).toEqual({ kind: "replay", response: { status: 201, body: { id: "one", n: 1 } } });
    expect(await claim(owner, key)).toEqual({ kind: "replay", response: { status: 201, body: { id: "one", n: 1 } } });

    const rows = await rowsOf(key);
    expect(rows.map((row) => [row.account_id, row.status, row.response_status])).toEqual([[owner, "done", 201]]);
    // 24 hours from the first use, on the database clock
    expect((rows[0]?.expires_at.getTime() ?? 0) - (rows[0]?.created_at.getTime() ?? 0)).toBeCloseTo(24 * HOUR_MS, -4);
  });

  it("stores a response without a body and replays it as one", async () => {
    const owner = await account();
    const key = freshId();

    await run(owner, key, null);

    expect(await claim(owner, key)).toEqual({ kind: "replay", response: { status: 201, body: null } });
  });

  it("answers a conflict, and changes nothing, for the same key with another operation or another request", async () => {
    const owner = await account();
    const key = freshId();
    await run(owner, key, { first: true });

    expect(await claim(owner, key, "createInvitation", "another request")).toEqual({ kind: "conflict" });
    expect(await claim(owner, key, "createBookmark")).toEqual({ kind: "conflict" });
    expect(await claim(owner, key)).toEqual({ kind: "replay", response: { status: 201, body: { first: true } } });
  });

  it("keeps the keys of two accounts apart: the same UUID is two keys, and an account never sees the other's response", async () => {
    const ada = await account();
    const grace = await account();
    const key = freshId();

    await run(ada, key, { for: "ada" }, "ada's request");

    expect(await claim(grace, key, "createInvitation", "grace's request")).toEqual({ kind: "claimed" });
    expect(await rowsOf(key)).toHaveLength(2);
    await inTenant(grace, (tx) => idempotencyRepository(tx).complete(key, { status: 201, body: { for: "grace" } }));
    expect(await claim(ada, key, "createInvitation", "ada's request")).toEqual({ kind: "replay", response: { status: 201, body: { for: "ada" } } });
    expect(await claim(grace, key, "createInvitation", "grace's request")).toEqual({ kind: "replay", response: { status: 201, body: { for: "grace" } } });
    expect((await rowsOf(key)).map((row) => row.account_id).sort()).toEqual([ada, grace].sort());
  });

  it("treats a key past its 24 hours as absent and claims it again for the new request", async () => {
    const owner = await account();
    const key = freshId();
    await run(owner, key, { old: true }, "old request");
    await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = ${key}`;
    });

    expect(await run(owner, key, { fresh: true }, "new request")).toEqual({ kind: "claimed" });

    expect(await claim(owner, key, "createInvitation", "new request")).toEqual({ kind: "replay", response: { status: 201, body: { fresh: true } } });
    const [row] = await rowsOf(key);
    expect(row?.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
  });

  it("leaves no key behind when the transaction that claimed it rolls back, so the retry runs", async () => {
    const owner = await account();
    const key = freshId();

    await expect(
      inTenant(owner, async (tx) => {
        await idempotencyRepository(tx).claim({ key, operation: "createInvitation", requestHash: hash("request") });
        throw new Error("the request failed");
      }),
    ).rejects.toThrow("the request failed");

    expect(await rowsOf(key)).toEqual([]);
    expect(await run(owner, key)).toEqual({ kind: "claimed" });
  });
});

describe("two requests with one key", { timeout: TEST_TIMEOUT_MS }, () => {
  it("makes the second wait for the first, then answers the first's response without claiming", async () => {
    const owner = await account();
    const key = freshId();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });

    const first = inTenant(owner, async (tx) => {
      const repository = idempotencyRepository(tx);
      const outcome = await repository.claim({ key, operation: "createInvitation", requestHash: hash("request") });
      claimed();
      await held;
      await repository.complete(key, { status: 201, body: { runs: 1 } });
      events.push("first finished");
      return outcome;
    });
    await firstClaimed;
    const second = claim(owner, key).then((outcome) => {
      events.push("second answered");
      return outcome;
    });
    await sleep(500);
    expect(events).toEqual([]);
    release();

    expect(await first).toEqual({ kind: "claimed" });
    expect(await second).toEqual({ kind: "replay", response: { status: 201, body: { runs: 1 } } });
    expect(events).toEqual(["first finished", "second answered"]);
  });

  it("lets the second claim the key when the first rolls back", async () => {
    const owner = await account();
    const key = freshId();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });

    const first = inTenant(owner, async (tx) => {
      await idempotencyRepository(tx).claim({ key, operation: "createInvitation", requestHash: hash("request") });
      claimed();
      await held;
      throw new Error("the first failed");
    });
    const failed = expect(first).rejects.toThrow("the first failed");
    await firstClaimed;
    const second = run(owner, key, { runs: 2 });
    await sleep(300);
    release();
    await failed;

    expect(await second).toEqual({ kind: "claimed" });
    expect(await claim(owner, key)).toEqual({ kind: "replay", response: { status: 201, body: { runs: 2 } } });
  });

  it("gives up waiting on a key whose request is still running after a few seconds, claiming nothing and ending its transaction", async () => {
    const owner = await account();
    const key = freshId();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const first = inTenant(owner, async (tx) => {
      await idempotencyRepository(tx).claim({ key, operation: "createInvitation", requestHash: hash("request") });
      claimed();
      await held;
    });
    await firstClaimed;

    const started = Date.now();
    const refused = await claim(owner, key).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(IdempotencyBusyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 500);
    release();
    await first;
    expect((await rowsOf(key)).map((row) => row.status)).toEqual(["in_progress"]);
  });

  it("restores the lock wait it changed, so the handler's own statements wait as they did", async () => {
    const owner = await account();
    const key = freshId();

    const [before, after] = await inTenant(owner, async (tx) => {
      const read = async (): Promise<string> => {
        const rows = await tenantHandle(tx).execute<{ value: string }>(sql`SELECT current_setting('lock_timeout') AS value`);
        return rows[0]?.value ?? "";
      };
      const first = await read();
      await idempotencyRepository(tx).claim({ key, operation: "createInvitation", requestHash: hash("request") });
      return [first, await read()] as const;
    });

    expect(after).toBe(before);
  });
});

describe("row-level security of idempotency_keys", { timeout: TEST_TIMEOUT_MS }, () => {
  async function appAs<T>(accountId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      return { value: await work(tx) };
    });
    return result.value;
  }

  it("shows an account its own keys only, whatever the statement names", async () => {
    const ada = await account();
    const grace = await account();
    const key = freshId();
    await run(ada, key);

    const named = await appAs(grace, (tx) => tx`SELECT key FROM idempotency_keys WHERE key = ${key}`);
    const all = await appAs(grace, (tx) => tx<{ key: string }[]>`SELECT key FROM idempotency_keys`);

    expect(named).toHaveLength(0);
    expect(all.map((row) => row.key)).not.toContain(key);
    expect(await appAs(ada, (tx) => tx`SELECT key FROM idempotency_keys WHERE key = ${key}`)).toHaveLength(1);
  });

  it("refuses to write a key for another account, and to change or delete one of another account", async () => {
    const ada = await account();
    const grace = await account();
    const key = freshId();
    await run(ada, key, { for: "ada" });

    const insert = await codeOf(
      appAs(grace, (tx) => tx`INSERT INTO idempotency_keys (account_id, key, operation, request_hash, expires_at) VALUES (${ada}, ${freshId()}, 'x', ${hash("x")}, now() + interval '1 day')`),
    );
    const update = await appAs(grace, (tx) => tx`UPDATE idempotency_keys SET response_status = 200 WHERE key = ${key} RETURNING key`);
    const remove = await codeOf(appAs(grace, (tx) => tx`DELETE FROM idempotency_keys WHERE key = ${key}`));

    expect(insert).toBe("42501");
    expect(update).toHaveLength(0);
    expect(remove).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await claim(ada, key)).toEqual({ kind: "replay", response: { status: 201, body: { for: "ada" } } });
  });

  it("refuses a row that says it is done without a response, and a stored response outside 2xx", async () => {
    const ada = await account();
    const key = freshId();
    await inTenant(ada, (tx) => idempotencyRepository(tx).claim({ key, operation: "createInvitation", requestHash: hash("request") }));

    const done = await codeOf(appAs(ada, (tx) => tx`UPDATE idempotency_keys SET status = 'done' WHERE key = ${key}`));
    const serverError = await codeOf(appAs(ada, (tx) => tx`UPDATE idempotency_keys SET status = 'done', response_status = 500 WHERE key = ${key}`));

    expect(done).toBe("23514");
    expect(serverError).toBe("23514");
  });
});
