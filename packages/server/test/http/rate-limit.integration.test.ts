import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defineOperation, jsonResponse, problemResponse, type RateBucket } from "@slugbase/contracts";
import { z } from "zod";
import { createServer, type RunningServer, type ServerModule } from "../../src/create-server.ts";
import { adapters, documentOf, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// Stages 3a and 6 over a real socket (doc 10 T9): GET /api/config, bucket `public`, is
// refused after the configured burst, and the client address the bucket is
// keyed by comes from the connection or the trusted X-Forwarded-For entry,
// never from the entries a client can write. The client is a raw socket: the
// repository allows no HTTP client outside the egress adapter.

interface Answer {
  readonly status: number;
  readonly headers: Map<string, string>;
  readonly body: string;
}

function get(port: number, headers: Record<string, string>, path = "/api/config"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const [head = "", body = ""] = text.split("\r\n\r\n");
      const [statusLine = "", ...lines] = head.split("\r\n");
      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers: new Map(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()] as const)),
        body,
      });
    });
    const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${lines.join("")}\r\n`);
  });
}

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

async function listen(hops: number, burst: number, modules: readonly ServerModule[] = []): Promise<number> {
  const config = serverConfig({ TRUSTED_PROXY_HOPS: String(hops), RATE_LIMIT_PUBLIC_IP: `${String(burst)}/min` });
  const server = createServer({
    config,
    adapters: adapters(config),
    modules,
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
  const started = await server.start({ port: 0 });
  running.push(started);
  return started.port;
}

describe("the rate-limit stage over a socket", () => {
  it("answers GET /api/config with 429 rate_limited after the configured burst", async () => {
    const port = await listen(0, 3);
    const answers = [await get(port, {}), await get(port, {}), await get(port, {}), await get(port, {})];
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 429]);
    expect(answers[0]?.headers.get("ratelimit-policy")).toBe('"public";q=3;w=60');
    expect(answers[0]?.headers.get("ratelimit")).toMatch(/^"public";r=2;t=\d+$/);
    const denied = answers[3];
    expect(denied?.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(denied?.headers.get("content-type")).toContain("application/problem+json");
    expect(JSON.parse(denied?.body ?? "{}")).toMatchObject({ code: "rate_limited", status: 429 });
    // The refusal is an answer like any other: the security headers of stage 2 are on it.
    expect(denied?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(denied?.headers.get("cache-control")).toBe("no-store");
    expect(denied?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("does not let a client that rotates X-Forwarded-For entries beyond the trusted hop evade the limit", async () => {
    const port = await listen(1, 3);
    const statuses: number[] = [];
    for (let spoof = 1; spoof <= 8; spoof += 1) {
      statuses.push((await get(port, { "X-Forwarded-For": `192.0.2.${String(spoof)}, 198.51.100.7` })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    expect((await get(port, { "X-Forwarded-For": "192.0.2.99, 198.51.100.8" })).status).toBe(200);
  });

  it("does not let a client evade the limit with X-Forwarded-For when no hop is trusted", async () => {
    const port = await listen(0, 3);
    const statuses: number[] = [];
    for (let spoof = 1; spoof <= 6; spoof += 1) {
      statuses.push((await get(port, { "X-Forwarded-For": `192.0.2.${String(spoof)}`, "X-Real-IP": `192.0.2.${String(spoof)}` })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it("answers GET /api/config with a bad bearer token 401 within the burst and 429 after it, without another token lookup", async () => {
    let lookups = 0;
    const rejecting: ServerModule = {
      name: "rejecting-bearer",
      register: () => ({
        authenticators: [
          {
            credential: "bearer",
            authenticate: () => {
              lookups += 1;
              return Promise.resolve(undefined);
            },
          },
        ],
      }),
    };
    const port = await listen(0, 3, [rejecting]);
    const answers: Answer[] = [];
    for (let request = 0; request < 6; request += 1) {
      answers.push(await get(port, { Authorization: `Bearer slb_${crypto.randomUUID()}` }));
    }
    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 429, 429, 429]);
    expect(lookups).toBe(3);
    const denied = answers[3];
    expect(denied?.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(denied?.headers.get("ratelimit")).toMatch(/^"public";r=0;t=\d+$/);
    expect(JSON.parse(denied?.body ?? "{}")).toMatchObject({ code: "rate_limited", status: 429 });
  });

  describe.each(["token_create", "bulk", "ai"] as const satisfies readonly RateBucket[])("a route of the %s bucket", (bucket) => {
    it("answers a flood of random bearer tokens from one IP 429 after the per-IP burst, without another token lookup", async () => {
      let lookups = 0;
      const path = `/api/v1/${bucket}`;
      const guarded: ServerModule = {
        name: `guarded-${bucket}`,
        register: () => ({
          routes: [
            {
              operation: defineOperation({
                method: "get",
                path,
                operationId: `guarded_${bucket}`,
                tag: "test",
                auth: "member",
                rate: bucket,
                responses: { 200: jsonResponse("ok", z.record(z.string(), z.unknown())), 404: problemResponse("not found") },
              }),
              handler: () => Response.json({ ok: true }),
            },
          ],
          authenticators: [
            {
              credential: "bearer",
              authenticate: () => {
                lookups += 1;
                return Promise.resolve(undefined);
              },
            },
          ],
        }),
      };
      const config = serverConfig({ [`RATE_LIMIT_${bucket.toUpperCase()}_IP`]: "3/hour" });
      const server = createServer({
        config,
        adapters: adapters(config),
        modules: [guarded],
        openApiDocument: documentOf([guarded]),
        migrations: [],
        logger: recordingLogger(),
        database: fakeDatabase(),
      });
      const started = await server.start({ port: 0 });
      running.push(started);
      const answers: Answer[] = [];
      for (let request = 0; request < 6; request += 1) {
        answers.push(await get(started.port, { Authorization: `Bearer slb_${crypto.randomUUID()}` }, path));
      }
      expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 429, 429, 429]);
      expect(lookups).toBe(3);
      expect(answers[3]?.headers.get("ratelimit")).toMatch(new RegExp(`^"${bucket}";r=0;t=\\d+$`));
      expect(JSON.parse(answers[3]?.body ?? "{}")).toMatchObject({ code: "rate_limited", status: 429 });
    });
  });
});
