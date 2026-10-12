import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer, type ServerModule } from "../src/create-server.ts";
import { adapters, fakeDatabase, operation, recordingLogger, serverConfig, documentOf } from "./support.ts";

// The listener over real sockets (doc 01 section 3 rule 2). The client is a raw
// socket: the repository allows no HTTP client outside the egress adapter.

interface Gate {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly wait: () => Promise<void>;
}

function gate(): Gate {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: () => {
      enter();
      return released;
    },
  };
}

function slowModule(slow: Gate, hang: Gate): ServerModule {
  return {
    name: "slow",
    register: () => ({
      routes: [
        {
          operation: operation("get", "/slow", "slow"),
          handler: async () => {
            await slow.wait();
            return Response.json({ done: true });
          },
        },
        {
          operation: operation("get", "/hang", "hang"),
          handler: async () => {
            await hang.wait();
            return Response.json({ done: true });
          },
        },
        {
          operation: operation("get", "/fast", "fast"),
          handler: () => Response.json({ fast: true }),
        },
      ],
    }),
  };
}

interface Exchange {
  readonly socket: Socket;
  /** Everything received until the server closed the connection. */
  readonly received: Promise<string>;
}

function send(port: number, path: string): Exchange {
  const socket = connect({ port, host: "127.0.0.1" });
  const chunks: Buffer[] = [];
  const received = new Promise<string>((resolve) => {
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  return { socket, received };
}

function refused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? "error");
    });
  });
}

const running: RunningServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

async function start(shutdownTimeoutMs: number, modules: ServerModule[]) {
  const database = fakeDatabase();
  const logger = recordingLogger();
  const server = createServer({
    config: serverConfig(),
    adapters: adapters(),
    modules,
    openApiDocument: documentOf(modules),
    migrations: [],
    logger,
    database,
    shutdownTimeoutMs,
  });
  const listening = await server.start({ port: 0 });
  running.push(listening);
  return { listening, database, logger };
}

describe("the listener", () => {
  it("serves a request over a socket through the chain", async () => {
    const { listening } = await start(5000, [slowModule(gate(), gate())]);
    const exchange = send(listening.port, "/fast");
    sockets.push(exchange.socket);
    const response = await Promise.race([
      new Promise<string>((resolve) => {
        exchange.socket.once("data", (chunk: Buffer) => {
          resolve(chunk.toString("utf8"));
        });
      }),
      exchange.received,
    ]);
    expect(response).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("finishes the in-flight request, refuses new connections and closes the pool on shutdown", async () => {
    const slow = gate();
    const { listening, database, logger } = await start(5000, [slowModule(slow, gate())]);
    const inflight = send(listening.port, "/slow");
    sockets.push(inflight.socket);
    await slow.entered;

    const shutdown = listening.shutdown();
    let finished = false;
    void shutdown.then(() => {
      finished = true;
    });

    expect(await refused(listening.port)).toBe("ECONNREFUSED");
    expect(finished).toBe(false);
    expect(database.closed.count).toBe(0);

    slow.release();
    const response = await inflight.received;
    expect(response).toMatch(/^HTTP\/1\.1 200 /);
    expect(response.toLowerCase()).toContain("connection: close");
    expect(response).toContain('{"done":true}');

    await shutdown;
    expect(database.closed.count).toBe(1);
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(false);
  });

  it("cuts a request still open at the deadline and then closes the pool", async () => {
    const hang = gate();
    const { listening, database, logger } = await start(300, [slowModule(gate(), hang)]);
    const stuck = send(listening.port, "/hang");
    sockets.push(stuck.socket);
    await hang.entered;

    const started = Date.now();
    await listening.shutdown();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(4000);
    expect(await stuck.received).not.toMatch(/HTTP\/1\.1 200/);
    expect(database.closed.count).toBe(1);
    expect(logger.entries.find((entry) => entry.level === "warn")?.message).toMatch(/deadline/);
    hang.release();
  });

  it("closes a kept-alive connection that is idle when the shutdown starts", async () => {
    const { listening } = await start(5000, [slowModule(gate(), gate())]);
    const idle = connect({ port: listening.port, host: "127.0.0.1" });
    sockets.push(idle);
    const closed = new Promise<void>((resolve) => {
      idle.on("close", () => {
        resolve();
      });
    });
    idle.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      idle.once("connect", resolve);
    });
    idle.write("GET /fast HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await new Promise<void>((resolve) => {
      idle.once("data", () => {
        resolve();
      });
    });

    await listening.shutdown();
    await closed;
  });

  it("returns the same shutdown when it is requested twice", async () => {
    const { listening, database } = await start(5000, []);
    const first = listening.shutdown();
    expect(listening.shutdown()).toBe(first);
    await first;
    expect(database.closed.count).toBe(1);
  });

  it("fails to start when the port is taken", async () => {
    const { listening } = await start(5000, []);
    const second = createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [],
      openApiDocument: documentOf([]),
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });
    await expect(second.start({ port: listening.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
