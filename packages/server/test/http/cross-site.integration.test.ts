import { connect } from "node:net";
import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer, type RouteBinding, type RunningServer } from "../../src/create-server.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig, documentOf } from "../support.ts";

// The cross-site rule over a real socket (doc 01 section 4 step 5, doc 10 T5):
// the request the listener hands the chain is what a browser's form post and a
// token client's call become, with the cookie dropped where the rule says so.
// The client is a raw socket: the repository allows no HTTP client outside the
// egress adapter.

const APP_ORIGIN = serverConfig().APP_ORIGIN;
const seen: { readonly method: string; readonly cookie: string | undefined; readonly body: string }[] = [];

function operationOf(method: "post" | "delete", path: string, operationId: string, audience?: "machine") {
  return defineOperation({
    method,
    path,
    operationId,
    tag: "test",
    auth: audience === "machine" ? "machine" : "member",
    rate: "none",
    ...(audience === undefined ? {} : { audience }),
    responses: { 200: jsonResponse("ok", z.record(z.string(), z.unknown())), 400: problemResponse("bad request") },
  });
}

const handler: RouteBinding["handler"] = async (context) => {
  seen.push({ method: context.req.method, cookie: context.req.header("cookie"), body: await context.req.text() });
  return Response.json({});
};

const routes: RouteBinding[] = [
  { operation: operationOf("post", "/api/v1/things", "createThing"), handler },
  { operation: operationOf("delete", "/api/v1/things/{id}", "deleteThing"), handler },
  { operation: operationOf("post", "/api/v1/events", "receiveEvent", "machine"), handler },
];

function exchange(port: number, method: string, path: string, headers: Record<string, string>, body = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const statusLine = Buffer.concat(chunks).toString("utf8").split("\r\n")[0] ?? "";
      resolve(Number(statusLine.split(" ")[1]));
    });
    const lines = Object.entries({ ...headers, "content-length": String(Buffer.byteLength(body)) }).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${lines.join("")}\r\n${body}`);
  });
}

const running: RunningServer[] = [];

afterEach(async () => {
  seen.length = 0;
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

async function listen(): Promise<number> {
  const server = createServer({
    config: serverConfig(),
    adapters: adapters(),
    modules: [{ name: "cross-site-fixture", register: () => ({ routes }) }],
    openApiDocument: documentOf([{ name: "cross-site-fixture", register: () => ({ routes }) }]),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
  const started = await server.start({ port: 0 });
  running.push(started);
  return started.port;
}

describe("the cross-site rule over a socket", () => {
  it("refuses a cross-site text/plain form that carries the member's cookie, and never calls the handler", async () => {
    const port = await listen();
    const status = await exchange(
      port,
      "POST",
      "/api/v1/things",
      { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain", cookie: "session=abc" },
      '{"title":"x"}',
    );
    expect(status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("hands the handler a same-origin JSON mutation with its cookie", async () => {
    const port = await listen();
    const status = await exchange(
      port,
      "POST",
      "/api/v1/things",
      { origin: APP_ORIGIN, "content-type": "application/json", cookie: "session=abc" },
      '{"title":"x"}',
    );
    expect(status).toBe(200);
    expect(seen).toEqual([{ method: "POST", cookie: "session=abc", body: '{"title":"x"}' }]);
  });

  it("drops the cookies of a bearer request, with a body and without one", async () => {
    const port = await listen();
    const headers = { authorization: "Bearer example-token", cookie: "session=abc" };
    expect(await exchange(port, "POST", "/api/v1/things", { ...headers, "content-type": "application/json" }, '{"title":"x"}')).toBe(200);
    expect(await exchange(port, "DELETE", "/api/v1/things/1", headers)).toBe(200);
    expect(seen).toEqual([
      { method: "POST", cookie: undefined, body: '{"title":"x"}' },
      { method: "DELETE", cookie: undefined, body: "" },
    ]);
  });

  it("drops the cookies of a machine route, which takes a request that is not from the app origin", async () => {
    const port = await listen();
    const status = await exchange(port, "POST", "/api/v1/events", { "content-type": "text/plain", cookie: "session=abc" }, "payload");
    expect(status).toBe(200);
    expect(seen).toEqual([{ method: "POST", cookie: undefined, body: "payload" }]);
  });

  it("refuses a preflight to the API", async () => {
    const port = await listen();
    const status = await exchange(port, "OPTIONS", "/api/v1/things", {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
    });
    expect(status).toBe(403);
  });
});
