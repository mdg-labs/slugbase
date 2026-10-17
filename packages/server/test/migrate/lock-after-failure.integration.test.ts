import { createServer, connect, type Server, type Socket } from "node:net";
import { getConstructionPlans } from "pg-boss";
import { describe, expect, it } from "vitest";
import { installPgBoss, PGBOSS_SCHEMA } from "../../src/migrate/pgboss.ts";
import { urlOf, useMigratableDatabase } from "./support.ts";

// The pool of the pg-boss step of `migrate` ends the connection of any failed
// statement and opens another for the next one, and the advisory lock of
// `migrate` lives in the session that ended (doc 05 section 5.3). When the
// construction plan fails because another process installed the schema first,
// the step carries on, and what it runs after that must run under the lock.

const database = useMigratableDatabase();

const PLAN_MARKER = "CREATE TYPE pgboss.job_state";

interface Statement {
  text: string;
  /** Whether the backend that received it held the lock of `migrate` when the statement arrived. */
  locked: boolean;
}

interface Relay {
  url: string;
  /** The queries the step sent on any connection after the construction plan was let fail, in order. */
  after: Statement[];
  close: () => Promise<void>;
}

async function holdsMigrateLock(pid: number): Promise<boolean> {
  const rows = await database().owner<{ held: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND pid = ${pid}
         AND classid = ((hashtext('slugbase.migrate')::bigint >> 32) & 4294967295)::oid
         AND objid = (hashtext('slugbase.migrate')::bigint & 4294967295)::oid
    ) AS held`;
  return rows[0]?.held === true;
}

const BACKEND_KEY_DATA = 0x4b;
const READY_FOR_QUERY = 0x5a;

// Follows the messages the server sends while a connection starts up and
// reports the backend process id of its BackendKeyData message.
function backendOf(upstream: Socket): () => number | undefined {
  let pid: number | undefined;
  let seen = Buffer.alloc(0);
  let offset = 0;
  let ready = false;
  upstream.on("data", (chunk: Buffer) => {
    if (ready) {
      return;
    }
    seen = Buffer.concat([seen, chunk]);
    while (!ready && offset + 5 <= seen.length) {
      const length = seen.readInt32BE(offset + 1);
      if (offset + 1 + length > seen.length) {
        break;
      }
      if (seen[offset] === BACKEND_KEY_DATA) {
        pid = seen.readInt32BE(offset + 5);
      }
      ready = seen[offset] === READY_FOR_QUERY;
      offset += 1 + length;
    }
  });
  return () => pid;
}

// Another process finishes the install while the step's construction plan is
// on its way, so that the plan finds its objects already there.
async function installBeforeThePlan(): Promise<void> {
  const session = await database().owner.reserve();
  try {
    await session.unsafe("SET ROLE slugbase_owner");
    await session.unsafe(getConstructionPlans(PGBOSS_SCHEMA, { createSchema: false }));
    await session.unsafe("RESET ROLE");
  } finally {
    session.release();
  }
}

async function relayRacingTheInstall(): Promise<Relay> {
  const target = new URL(urlOf(database().owner));
  const sockets = new Set<Socket>();
  const after: Statement[] = [];
  let planSeen = false;
  const listener: Server = createServer((client) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    const backend = backendOf(upstream);
    sockets.add(client);
    sockets.add(upstream);
    let queue = Promise.resolve();
    const dropBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk: Buffer) => {
      queue = queue.then(async () => {
        if (!planSeen && chunk.includes(PLAN_MARKER)) {
          planSeen = true;
          await installBeforeThePlan();
        } else if (planSeen && chunk.toString("latin1").startsWith("Q")) {
          const pid = backend();
          after.push({ text: chunk.toString("latin1"), locked: pid !== undefined && (await holdsMigrateLock(pid)) });
        }
        upstream.write(chunk);
      });
      queue.catch(dropBoth);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    client.on("error", dropBoth);
    upstream.on("error", dropBoth);
    client.on("close", dropBoth);
    upstream.on("close", dropBoth);
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as { port: number };
  const url = new URL(target.href);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.href,
    after,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    },
  };
}

describe("the pg-boss step of migrate after its construction plan finds the schema installed", () => {
  it("runs what follows under the migrate lock of its new session", async () => {
    const relay = await relayRacingTheInstall();
    try {
      const installed = await installPgBoss(relay.url);

      expect(installed).toBeUndefined();
    } finally {
      await relay.close();
    }

    const onSchema = relay.after.filter((statement) => statement.text.includes("pgboss"));
    expect(onSchema.some((statement) => statement.text.includes("pgboss.version"))).toBe(true);
    expect(onSchema.filter((statement) => !statement.locked)).toEqual([]);
    expect(
      await database().owner`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    ).toEqual([{ n: 0 }]);
  }, 60_000);
});
