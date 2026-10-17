import { createServer, connect, type Server, type Socket } from "node:net";
import { MigrationError } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { installPgBoss, PGBOSS_SCHEMA } from "../../src/migrate/pgboss.ts";
import { urlOf, useMigratableDatabase } from "./support.ts";

// A connection the pg-boss step of `migrate` loses once it knows its backend is
// reported as replaced (doc 05 section 5.3), however the loss shows: a closed
// socket, a reset, or the server's termination error.

const database = useMigratableDatabase();

const LOCK = "SELECT pg_try_advisory_lock(hashtext('slugbase.migrate'))";

type Loss = "closed" | "reset" | "terminated";

// The server's answer to a terminated backend, as the wire protocol carries it.
function terminationResponse(): Buffer {
  const fields = ["SFATAL", "VFATAL", "C57P01", "Mterminating connection due to administrator command"];
  const body = Buffer.concat([...fields.map((field) => Buffer.from(`${field}\0`)), Buffer.from("\0")]);
  const header = Buffer.alloc(5);
  header.write("E");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

interface Relay {
  url: string;
  close: () => Promise<void>;
}

// A relay between the step and the development Postgres that, instead of
// forwarding the first client write containing the given statement text, ends
// the connection that sent it, so the step loses its connection at a known
// point with that statement in flight. Later connections are forwarded.
async function relayDroppingAt(statement: string, loss: Loss): Promise<Relay> {
  const target = new URL(urlOf(database().owner));
  const sockets = new Set<Socket>();
  let dropped = false;
  const listener: Server = createServer((client) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(client);
    sockets.add(upstream);
    let dropping = false;
    const dropBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk: Buffer) => {
      if (dropping) {
        return;
      }
      if (!dropped && chunk.includes(statement)) {
        dropped = true;
        dropping = true;
        if (loss === "terminated") {
          client.write(terminationResponse());
          setTimeout(dropBoth, 100);
        } else if (loss === "reset") {
          client.resetAndDestroy();
          upstream.destroy();
        } else {
          dropBoth();
        }
        return;
      }
      upstream.write(chunk);
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

async function rejection(run: Promise<unknown>): Promise<MigrationError> {
  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(MigrationError);
  return failure as MigrationError;
}

describe("a connection lost in the pg-boss step of migrate", () => {
  it.each([
    { loss: "closed", codes: [undefined] },
    { loss: "reset", codes: ["ECONNRESET", undefined] },
    { loss: "terminated", codes: ["57P01"] },
  ] as const)("while it waits for the lock is a replaced connection ($loss)", async ({ loss, codes }) => {
    const holder = await database().owner.reserve();
    await holder.unsafe("SELECT pg_advisory_lock(hashtext('slugbase.migrate'))");
    const relay = await relayDroppingAt(LOCK, loss);
    try {
      const error = await rejection(installPgBoss(relay.url));

      expect(error.message).toContain("connection was replaced");
      expect(codes).toContain(error.code);
    } finally {
      await holder.unsafe("SELECT pg_advisory_unlock(hashtext('slugbase.migrate'))");
      holder.release();
      await relay.close();
    }
  }, 60_000);

  it.each([
    { loss: "closed", codes: [undefined] },
    { loss: "terminated", codes: ["57P01"] },
  ] as const)("while it holds the lock and installs the schema is a replaced connection ($loss)", async ({ loss, codes }) => {
    const relay = await relayDroppingAt("CREATE TYPE pgboss.job_state", loss);
    try {
      const error = await rejection(installPgBoss(relay.url));

      expect(error.message).toContain("connection was replaced");
      expect(codes).toContain(error.code);
    } finally {
      await relay.close();
    }
    expect(await database().owner`SELECT to_regclass(${`${PGBOSS_SCHEMA}.version`}) AS present`).toEqual([{ present: null }]);
  }, 60_000);

  it("keeps the driver's message for an error that is not a lost connection", async () => {
    const error = await rejection(installPgBoss(urlOf(database().owner).replace(/\/[^/]+$/, "/no_such_database")));

    expect(error.message).not.toContain("connection was replaced");
    expect(error.message).toContain("the pg-boss schema or its queues could not be set up");
  }, 60_000);
});
