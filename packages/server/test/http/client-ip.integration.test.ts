import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer, type ServerModule } from "../../src/create-server.ts";
import { adapters, fakeAuthStore, fakeDatabase, operation, recordingLogger, serverConfig, documentOf } from "../support.ts";

// The client IP and the request ID over a real socket (doc 10 T9): the address
// the handler sees comes from the connection, or from the trusted
// `X-Forwarded-For` entry. The client is a raw socket: the repository allows no
// HTTP client outside the egress adapter.

const whoami: ServerModule = {
  name: "whoami",
  register: () => ({
    routes: [
      {
        operation: operation("get", "/api/v1/whoami", "whoami"),
        handler: (context) => Response.json({ ip: context.get("clientIp") ?? null }),
      },
    ],
  }),
};

function get(port: number, headers: Record<string, string>): Promise<{ head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const [head = "", body = ""] = text.split("\r\n\r\n");
      resolve({ head, body });
    });
    const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(`GET /api/v1/whoami HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${lines.join("")}\r\n`);
  });
}

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

async function listen(hops: number): Promise<number> {
  const server = createServer({
    config: serverConfig({ TRUSTED_PROXY_HOPS: String(hops) }),
    adapters: adapters(),
    modules: [whoami],
    openApiDocument: documentOf([whoami]),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
    authStore: fakeAuthStore(),
  });
  const started = await server.start({ port: 0 });
  running.push(started);
  return started.port;
}

describe("the request context over a socket", () => {
  it("with no trusted hops the handler sees the connection's address, whatever X-Forwarded-For says", async () => {
    const port = await listen(0);
    const { body } = await get(port, { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "7.7.7.7" });
    expect((JSON.parse(body) as { ip: string }).ip).toMatch(/127\.0\.0\.1$/);
  });

  it("with one trusted hop the handler sees the entry the proxy appended, not the ones the client sent", async () => {
    const port = await listen(1);
    const { body } = await get(port, { "X-Forwarded-For": "6.6.6.6, 198.51.100.7" });
    expect((JSON.parse(body) as { ip: string }).ip).toBe("198.51.100.7");
  });

  it("returns the accepted request ID in the response header", async () => {
    const port = await listen(0);
    const { head } = await get(port, { "X-Request-Id": "edge-7f3a9c1e.04" });
    expect(head.toLowerCase()).toContain("x-request-id: edge-7f3a9c1e.04");
  });
});
