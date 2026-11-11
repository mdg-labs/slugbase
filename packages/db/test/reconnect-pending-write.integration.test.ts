import { connect, type Socket } from "node:net";
import { setImmediate as nextImmediate, setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

// A socket that closes while the driver still holds bytes it has not written
// yet (doc 01 section 5): postgres.js collects a query's bytes in a buffer and
// writes them from an immediate callback. When the socket closes in between,
// the connection that replaces it starts with the StartupMessage; any byte of
// the lost query before it, or a write timer left over from the lost socket
// that keeps the startup from being scheduled, leaves the new connection
// waiting for a startup that never reaches the server. When the socket is
// destroyed with an error, 'error' fires before 'close'; a query run on the
// connection between the two has its bytes dropped by the close, so it has to
// be rejected there, never resolved by the startup of the next socket.

const HOOK_TIMEOUT_MS = 300_000;
const CONNECT_TIMEOUT_SECONDS = 3;
const TEST_TIMEOUT_MS = 30_000;

let db: TestDatabase;
const pools: postgres.Sql[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  await db.owner`CREATE TABLE reconnect_pending (id int NOT NULL)`;
  await db.owner`GRANT SELECT, INSERT ON reconnect_pending TO slugbase_app`;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  for (const pool of pools) {
    await pool.end({ timeout: 5 });
  }
  await db.drop();
}, HOOK_TIMEOUT_MS);

async function connectedSocket(host: string, port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

interface Rig {
  client: postgres.Sql;
  sockets: Socket[];
}

function rig(): Rig {
  const { options } = db.app;
  const sockets: Socket[] = [];
  // The driver accepts a `socket` factory its type declarations omit.
  const socketFactory = {
    socket: async () => {
      const socket = await connectedSocket(String(options.host[0]), Number(options.port[0]));
      sockets.push(socket);
      return socket;
    },
  };
  const client = postgres({
    host: String(options.host[0]),
    port: Number(options.port[0]),
    username: options.user,
    password: String(options.pass),
    database: options.database,
    max: 1,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    onnotice: () => undefined,
    ...socketFactory,
  });
  pools.push(client);
  return { client, sockets };
}

// Calls then() at once: a query is lazy, and it is then() that hands it to the
// connection, so the query is run in the caller's tick.
function outcome(run: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(
    run.then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
}

async function rowCount(client: postgres.Sql): Promise<number> {
  const rows = await client<{ n: number }[]>`SELECT count(*)::int AS n FROM reconnect_pending`;
  return rows[0]?.n ?? -1;
}

describe("a postgres.js connection", () => {
  it("starts a reconnect with the StartupMessage when the socket closed with a write pending", async () => {
    const { client, sockets } = rig();

    expect(await client`SELECT 1 AS one`).toHaveLength(1);
    expect(sockets).toHaveLength(1);

    // The query's bytes are collected when the immediate callback below ends
    // and are due to be written by an immediate of the next loop iteration; the
    // socket closes in the closing phase of this one, in between.
    let lost: Promise<unknown> = Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        lost = outcome(client`SELECT 2 AS two`);
        sockets[0]?.destroy();
        resolve();
      });
    });
    expect(await lost).toMatchObject({ code: "CONNECTION_CLOSED" });
    // Gives the loop the iteration in which the lost write would have run.
    await nextImmediate();
    await nextImmediate();

    expect(await client`SELECT 3 AS three`).toHaveLength(1);
    expect(sockets).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it("rejects an idle connection's query run between the error and the close of its socket", async () => {
    const { client, sockets } = rig();

    expect(await client`SELECT 1 AS one`).toHaveLength(1);

    const windowQuery = new Promise<unknown>((resolve) => {
      sockets[0]?.once("error", () => {
        resolve(outcome(client`INSERT INTO reconnect_pending (id) VALUES (1)`));
      });
    });
    sockets[0]?.destroy(new Error("ECONNRESET"));

    expect(await Promise.race([windowQuery, sleep(CONNECT_TIMEOUT_SECONDS * 2000).then(() => "pending")])).toMatchObject({
      code: "CONNECTION_CLOSED",
    });
    expect(await client`SELECT 2 AS two`).toHaveLength(1);
    expect(await client`SELECT 3 AS three`).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(await rowCount(client)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("rejects a query queued behind a running one between the error and the close of its socket", async () => {
    const { client, sockets } = rig();

    expect(await client`SELECT 1 AS one`).toHaveLength(1);
    const running = outcome(client`SELECT pg_sleep(5)`);
    await sleep(200);

    const windowQuery = new Promise<unknown>((resolve) => {
      sockets[0]?.once("error", () => {
        resolve(outcome(client`INSERT INTO reconnect_pending (id) VALUES (2)`));
      });
    });
    sockets[0]?.destroy(new Error("ECONNRESET"));

    expect(await running).toBeInstanceOf(Error);
    expect(await Promise.race([windowQuery, sleep(CONNECT_TIMEOUT_SECONDS * 2000).then(() => "pending")])).toMatchObject({
      code: "CONNECTION_CLOSED",
    });
    expect(await client`SELECT 2 AS two`).toHaveLength(1);
    expect(await client`SELECT 3 AS three`).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(await rowCount(client)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("runs the queries after a transaction whose socket was destroyed with an error", async () => {
    const { client, sockets } = rig();

    expect(await client`SELECT 1 AS one`).toHaveLength(1);
    const transaction = outcome(client.begin((sql) => sql`SELECT pg_sleep(1)`));
    await sleep(150);
    sockets[0]?.destroy(new Error("ECONNRESET"));

    expect(await transaction).toBeInstanceOf(Error);
    expect(await client`SELECT 2 AS two`).toHaveLength(1);
    expect(await client`SELECT 3 AS three`).toHaveLength(1);
    expect(sockets).toHaveLength(2);
  }, TEST_TIMEOUT_MS);
});
