import { sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type CompleteSetup } from "../src/index.ts";
import { bindTenantDatabase, tenantHandle } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { relayDroppingAt, type Relay } from "./support/connection-relay.ts";
import { asSystem, freshId, freshToken } from "./support/auth-fixture.ts";
import { ACCOUNT_A, WORKSPACE_A } from "./support/tenant-fixture.ts";

// A connection lost while a transaction callback runs (doc 01 section 5): the
// transaction rejects with an error to its caller, and the process keeps
// running. postgres.js writes ROLLBACK for a rejected callback, and by then the
// connection has no socket to write to; unless the driver rejects that query,
// the write throws outside any promise chain and ends the process. The tests
// swap the process-level handlers for their own, so such a throw is counted
// here instead of ending the test worker.

const HOOK_TIMEOUT_MS = 300_000;
const SETTLE_MS = 300;

let db: TestDatabase;
const relays: Relay[] = [];
const pools: postgres.Sql[] = [];
const stores: AuthStore[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  for (const store of stores) {
    await store.close();
  }
  for (const pool of pools) {
    await pool.end({ timeout: 5 });
  }
  for (const relay of relays) {
    await relay.close();
  }
  await db.drop();
}, HOOK_TIMEOUT_MS);

function appUrl(port?: number): string {
  const { options } = db.app;
  const url = new URL("postgres://localhost");
  url.hostname = port === undefined ? String(options.host[0]) : "127.0.0.1";
  url.port = port === undefined ? String(options.port[0]) : String(port);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

async function relay(statement: string, terminated = false): Promise<Relay> {
  const { options } = db.app;
  const upstream = new URL("postgres://localhost");
  upstream.hostname = String(options.host[0]);
  upstream.port = String(options.port[0]);
  const started = await relayDroppingAt(upstream, statement, { terminated });
  relays.push(started);
  return started;
}

function pool(url: string): postgres.Sql {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  pools.push(client);
  return client;
}

interface Escapes {
  uncaught: unknown[];
}

// Runs the scenario with the process-level handlers replaced by ones that
// record what reaches them, waits for the immediate callbacks the driver
// schedules, and puts the handlers back.
async function watchingEscapes(scenario: () => Promise<void>): Promise<Escapes> {
  const uncaught: unknown[] = [];
  const record = (error: unknown): void => {
    uncaught.push(error);
  };
  const exceptionListeners = process.listeners("uncaughtException");
  const rejectionListeners = process.listeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  try {
    await scenario();
    await sleep(SETTLE_MS);
  } finally {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
    for (const listener of exceptionListeners) {
      process.on("uncaughtException", listener);
    }
    for (const listener of rejectionListeners) {
      process.on("unhandledRejection", listener);
    }
  }
  return { uncaught };
}

async function rejection(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the transaction to reject");
}

function setupRequest(): CompleteSetup {
  return {
    accountId: freshId(),
    workspaceId: freshId(),
    sessionId: freshId(),
    email: `loss-${freshId()}@example.test`,
    displayName: "First Admin",
    passwordHash: "$argon2id$stub",
    locale: "en",
    workspaceName: "First workspace",
    tokenRequired: false,
    tokenHash: null,
    sessionTokenHash: freshToken().hash,
    ipPrefix: "203.0.0.0/16",
    userAgent: "Vitest",
  };
}

const TENANT = { accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-loss" };

describe("withTenant", () => {
  it("rejects when the socket closes inside the transaction, and the process keeps running", async () => {
    const started = await relay("loss_marker_socket");
    const client = pool(appUrl(started.port));
    const { withTenant } = bindTenantDatabase(client);
    let error: Error | undefined;
    const escapes = await watchingEscapes(async () => {
      error = await rejection(
        withTenant(TENANT, async (tx) => {
          await tenantHandle(tx).execute(sql`SELECT 'loss_marker_socket'`);
        }),
      );
    });
    expect(started.dropped()).toBe(true);
    expect(error).toBeDefined();
    expect(escapes.uncaught).toEqual([]);
    expect(await client`SELECT 1 AS one`).toHaveLength(1);
  });

  it("rejects when the backend is terminated inside the transaction, and the process keeps running", async () => {
    const client = pool(appUrl());
    const { withTenant } = bindTenantDatabase(client);
    let error: Error | undefined;
    const escapes = await watchingEscapes(async () => {
      error = await rejection(
        withTenant(TENANT, async (tx) => {
          await tenantHandle(tx).execute(sql`SELECT pg_terminate_backend(pg_backend_pid())`);
        }),
      );
    });
    expect(error).toBeDefined();
    expect(escapes.uncaught).toEqual([]);
  });

  // The server's termination error reaches the client with no ReadyForQuery
  // after it; only the request that was running fails, and the first query on
  // the reconnected connection gets its own answer.
  it("runs the next query on the same pool after the backend was terminated", async () => {
    const client = pool(appUrl());
    const { withTenant } = bindTenantDatabase(client);
    await rejection(
      withTenant(TENANT, async (tx) => {
        await tenantHandle(tx).execute(sql`SELECT pg_terminate_backend(pg_backend_pid())`);
      }),
    );
    expect(await client`SELECT 1 AS one`).toHaveLength(1);
  });

  it("runs the next withTenant transaction on the same pool after the backend was terminated", async () => {
    const client = pool(appUrl());
    const { withTenant } = bindTenantDatabase(client);
    await rejection(
      withTenant(TENANT, async (tx) => {
        await tenantHandle(tx).execute(sql`SELECT pg_terminate_backend(pg_backend_pid())`);
      }),
    );
    const answer = await withTenant(TENANT, async (tx) => tenantHandle(tx).execute(sql`SELECT 1 AS one`));
    expect(answer).toHaveLength(1);
  });

  it("runs the next query on a pool whose relay delivered the termination error", async () => {
    const started = await relay("loss_marker_terminated", true);
    const client = pool(appUrl(started.port));
    const { withTenant } = bindTenantDatabase(client);
    await rejection(
      withTenant(TENANT, async (tx) => {
        await tenantHandle(tx).execute(sql`SELECT 'loss_marker_terminated'`);
      }),
    );
    expect(started.dropped()).toBe(true);
    expect(await client`SELECT 1 AS one`).toHaveLength(1);
  });
});

describe("a system repository transaction", () => {
  for (const [name, terminated] of [
    ["the socket closes", false],
    ["the backend is terminated", true],
  ] as const) {
    it(`rejects when ${name} inside completeSetup, leaves no account, and the process keeps running`, async () => {
      const started = await relay("sys_complete_setup", terminated);
      const store = createAuthStore({ url: appUrl(started.port), poolSize: 1 });
      stores.push(store);
      await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
      let error: Error | undefined;
      const escapes = await watchingEscapes(async () => {
        error = await rejection(store.completeSetup(setupRequest()));
      });
      expect(started.dropped()).toBe(true);
      expect(error).toBeDefined();
      expect(escapes.uncaught).toEqual([]);
      const accounts = await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM accounts`);
      expect(accounts[0]?.n).toBe(0);
      if (!terminated) {
        expect(await store.setupPending()).toBe(true);
      }
    });
  }
});
