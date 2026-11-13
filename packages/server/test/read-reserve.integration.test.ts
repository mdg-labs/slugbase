import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase, createUsageStore } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../src/auth/tenant-resolver.ts";
import { createServer } from "../src/create-server.ts";
import { WORKSPACE_WRITERS } from "../src/read-reserve.ts";
import { createUsageBuffer } from "../src/usage/buffer.ts";
import { storeFor } from "./auth/support.ts";
import { appUrl } from "./contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "./support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type World } from "./workspaces/support.ts";

// The read reserve of the server's tenant pool (doc 01 section 9.2). An import holds its workspace's row from the moment it takes its places until it
// commits, and every bookmark create of that workspace waits on that row inside a tenant transaction, holding one connection of the pool for it. Without a
// bound the pool's ten connections fill with such waiters and the reads of every other workspace (`GET /api/v1/bookmarks`, `GET /go/<slug>`) wait for a connection
// until the import commits; with the reserve alone seven of them idle, and with the cap per workspace two. The failure scenario: more creates than the pool has
// connections wait on one workspace's row, and while the row is held at most `WORKSPACE_WRITERS` of the server's backends wait for a lock, a create of another
// workspace and the reads of it (a list, a navigation) answer within the bound below; after the row is released every create answers 201 and each of them stored one bookmark.

const TEST_TIMEOUT_MS = 120_000;
const BOOKMARKS = "/api/v1/bookmarks";
const POOL_SIZE = 10;
// As many creates as the pool has connections, half of them under an Idempotency-Key (the stage of that name opens the transaction of a keyed create, the handler's own call joins it).
const CREATES = POOL_SIZE;
// The most a read, or a create of another workspace, may take while the row is held. A request that has to wait for a connection or for a place waits for the release, which this test does not make until the requests have answered or this bound has passed.
const READ_BOUND_MS = 4_000;
const WAIT_MS = 30_000;
// The writers that wait on the row hold their connections, so the number of backends that wait is as high as it gets once it stays put for this many samples.
const SETTLED_SAMPLES = 8;

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

/**
 * How many backends wait for a lock in this database (the activity view shows the owner role nothing of the application's backends, the lock table does): the one that waits
 * for the transaction `holder` and the ones queued behind it on the row.
 */
async function lockWaiters(holder: string): Promise<number> {
  const rows = await database().owner<{ count: number }[]>`
    SELECT count(DISTINCT pid)::int AS count FROM pg_locks
    WHERE NOT granted AND (database = (SELECT oid FROM pg_database WHERE datname = current_database()) OR (locktype = 'transactionid' AND transactionid = ${holder}::xid))`;
  return rows[0]?.count ?? 0;
}

/** Waits until at least `least` backends wait for a lock and the number has stopped rising, so the pool holds all the waiters it will. */
async function lockWaitersSettled(holder: string, least: number): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  let last = -1;
  let same = 0;
  for (;;) {
    const now = await lockWaiters(holder);
    same = now === last ? same + 1 : 0;
    last = now;
    if (now >= least && same >= SETTLED_SAMPLES) {
      return now;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${String(least)} backends to wait for a lock and settle (${String(now)} wait)`);
    }
    await sleep(50);
  }
}

async function storedUrls(workspaceId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ url: string }[]>`SELECT url FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY url`;
  });
  return rows.map((row) => row.url);
}

async function bookmarkCount(workspaceId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`;
  });
  return rows[0]?.bookmark_count ?? -1;
}

describe("a request of another workspace while creates wait on a workspace's row", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is answered while the row is held, with at most the writers of a workspace waiting on it, and every create completes once it is released", async () => {
    const setup = harness.serve();
    const writer = await harness.person(setup);
    const reader = await harness.person(setup);
    const busy = await harness.workspaceOf([{ person: writer, role: "owner" }]);
    const quiet = await harness.workspaceOf([{ person: reader, role: "owner" }]);
    const otherCreate = "https://example.com/other-workspace";
    const made = await send(setup, "POST", BOOKMARKS, { cookie: reader.cookie }, { url: "https://example.com/mail", title: "Mail", slug: "mail", forwarding: true });
    expect(made.status).toBe(201);

    // The server under load has the pool the CE composition gives it, which the harness's own pool (four connections) is not.
    const tenant = createDatabase({ url: appUrl(database()), poolSize: POOL_SIZE });
    const store = storeFor(database());
    const usageStore = createUsageStore({ url: appUrl(database()), poolSize: 2 });
    const usage = createUsageBuffer({ store: usageStore, logger: recordingLogger() });
    const config = serverConfig({
      NODE_ENV: "test",
      DATABASE_URL: appUrl(database()),
      RATE_LIMIT_WRITE_IP: "10000/min",
      RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
      RATE_LIMIT_READ_IP: "10000/min",
      RATE_LIMIT_READ_ACCOUNT: "10000/min",
      RATE_LIMIT_GO_IP: "10000/min",
      RATE_LIMIT_GO_ACCOUNT: "10000/min",
    });
    const loaded: World = {
      server: createServer({
        config,
        adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
        modules: [],
        migrations: [],
        logger: recordingLogger(),
        database: tenant,
        authStore: store,
        usage,
      }),
      origin: config.APP_ORIGIN,
    };

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The import's hold: the workspace's row, as sys_bookmark_count_take_many takes it, until the transaction ends.
    const holderXid = Promise.withResolvers<string>();
    const holding = database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`SELECT id FROM workspaces WHERE id = ${busy.workspaceId} FOR NO KEY UPDATE`;
      const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
      holderXid.resolve(row?.xid ?? "");
      await released;
    });
    holding.catch(() => undefined);

    try {
      const urls = Array.from({ length: CREATES }, (_, index) => `https://example.com/queued/${String(index)}`);
      const creates = urls.map((url, index) =>
        send(loaded, "POST", BOOKMARKS, { cookie: writer.cookie, ...(index % 2 === 0 ? { "idempotency-key": randomUUID() } : {}) }, { url, title: `Queued ${String(index)}` }),
      );
      // The creates of one workspace may hold WORKSPACE_WRITERS connections; with the reserve alone they take seven, and without it all ten.
      const waiting = await lockWaitersSettled(await holderXid.promise, WORKSPACE_WRITERS);
      expect(waiting, `${String(waiting)} backends wait for a lock with ${String(CREATES)} creates of one workspace waiting on its row`).toBeLessThanOrEqual(WORKSPACE_WRITERS);

      const started = Date.now();
      const bound = async <T>(request: Promise<T>): Promise<T | "late"> => Promise.race([request, sleep(READ_BOUND_MS).then(() => "late" as const)]);
      const [create, list, go] = await Promise.all([
        bound(send(loaded, "POST", BOOKMARKS, { cookie: reader.cookie }, { url: otherCreate, title: "Other workspace" })),
        bound(send(loaded, "GET", BOOKMARKS, { cookie: reader.cookie })),
        bound(loaded.server.fetch(new Request(new URL("/go/mail", loaded.origin), { method: "GET", headers: { accept: "text/html", cookie: reader.cookie } }))),
      ]);
      const elapsed = Date.now() - started;

      expect(create, `the create of another workspace waited more than ${String(READ_BOUND_MS)} ms with ${String(waiting)} creates waiting on the row`).not.toBe("late");
      expect(list, `the list waited more than ${String(READ_BOUND_MS)} ms with ${String(waiting)} creates waiting on the row`).not.toBe("late");
      expect(go, `the navigation waited more than ${String(READ_BOUND_MS)} ms with ${String(waiting)} creates waiting on the row`).not.toBe("late");
      if (create === "late" || list === "late" || go === "late") {
        return;
      }
      expect(create.status).toBe(201);
      expect(list.status).toBe(200);
      expect(go.status).toBe(302);
      expect(go.headers.get("location")).toBe("https://example.com/mail");
      expect(elapsed).toBeLessThan(READ_BOUND_MS);

      release();
      await holding;
      const answers = await Promise.all(creates);
      expect(answers.map((response) => response.status)).toEqual(creates.map(() => 201));
      expect(await storedUrls(busy.workspaceId)).toEqual([...urls].sort());
      expect(await bookmarkCount(busy.workspaceId)).toBe(CREATES);
      expect(await bookmarkCount(quiet.workspaceId)).toBe(2);
      expect(await storedUrls(quiet.workspaceId)).toEqual(["https://example.com/mail", otherCreate]);
    } finally {
      release();
      await holding.catch(() => undefined);
      await usage.stop();
      await Promise.all([tenant.close(), store.close(), usageStore.close()]);
    }
  });
});
