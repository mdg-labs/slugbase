import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer, type ServerModule } from "../../src/create-server.ts";
import { DEFAULT_MAX_BODY_BYTES } from "../../src/http/body-limits.ts";
import { acceptAnyBearer, adapters, fakeDatabase, recordingLogger, serverConfig, documentOf } from "../support.ts";

// Stage 3 of the chain (doc 01 section 4), exercised through test routes a test
// module registers: no product mutation exists yet.

const Echo = z.record(z.string(), z.unknown());
const Body = z.strictObject({ note: z.string().optional() });
const LARGE_LIMIT = 5 * 1024 * 1024;

function post(path: string, operationId: string, options: { json: boolean; maxBodyBytes?: number }) {
  return {
    operation: defineOperation({
      method: "post",
      path,
      operationId,
      tag: "test",
      auth: "anonymous",
      rate: "none",
      ...(options.json ? { request: { body: Body } } : {}),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      responses: { 200: jsonResponse("ok", Echo), 400: problemResponse("bad request") },
    }),
    handler: async (context: { req: { text(): Promise<string> } }) => Response.json({ length: (await context.req.text()).length }),
  };
}

const testRoutes: ServerModule = {
  name: "body-limit-routes",
  register: () => ({
    routes: [
      post("/api/v1/json", "postJson", { json: true }),
      post("/api/v1/plain", "postPlain", { json: false }),
      post("/api/v1/big", "postBig", { json: true, maxBodyBytes: LARGE_LIMIT }),
      {
        ...post("/api/v1/thing", "deleteThing", { json: false }),
        operation: defineOperation({
          method: "delete",
          path: "/api/v1/thing",
          operationId: "deleteThing",
          tag: "test",
          auth: "anonymous",
          rate: "none",
          responses: { 200: jsonResponse("ok", Echo), 404: problemResponse("missing") },
        }),
      },
    ],
  }),
};

function server() {
  // The authentication stage is not under test: it accepts every Authorization header, so the content type of a bearer mutation is.
  const bearer = acceptAnyBearer();
  return createServer({
    config: serverConfig(),
    adapters: { ...adapters(), tenantResolver: bearer.tenantResolver },
    modules: [testRoutes, bearer.module],
    openApiDocument: documentOf([testRoutes]),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

function jsonOfLength(length: number): string {
  const overhead = JSON.stringify({ note: "" }).length;
  return JSON.stringify({ note: "a".repeat(length - overhead) });
}

const APP_ORIGIN = serverConfig().APP_ORIGIN;

// A browser-facing mutation comes from the app's own origin (stage 5); the tests here are about stage 3.
function request(path: string, init: RequestInit): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) {
    headers.set("origin", APP_ORIGIN);
  }
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function problemOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

describe("the body-limits stage", () => {
  it("defaults to 64 KiB", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it("accepts a body of exactly the default limit and refuses one byte more with 413 payload_too_large", async () => {
    const app = server();
    const exact = await app.fetch(request("/api/v1/json", { method: "POST", headers: JSON_HEADERS, body: jsonOfLength(DEFAULT_MAX_BODY_BYTES) }));
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({ length: DEFAULT_MAX_BODY_BYTES });

    const over = await app.fetch(request("/api/v1/json", { method: "POST", headers: JSON_HEADERS, body: jsonOfLength(DEFAULT_MAX_BODY_BYTES + 1) }));
    expect(over.status).toBe(413);
    expect(await problemOf(over)).toMatchObject({ code: "payload_too_large", status: 413 });
  });

  it("closes the connection after refusing a body", async () => {
    const response = await server().fetch(
      request("/api/v1/json", { method: "POST", headers: JSON_HEADERS, body: jsonOfLength(DEFAULT_MAX_BODY_BYTES + 1) }),
    );
    expect(response.headers.get("connection")).toBe("close");
  });

  it("reads the limit of a route from its operation", async () => {
    const app = server();
    const inside = await app.fetch(request("/api/v1/big", { method: "POST", headers: JSON_HEADERS, body: jsonOfLength(DEFAULT_MAX_BODY_BYTES * 8) }));
    expect(inside.status).toBe(200);
    const over = await app.fetch(request("/api/v1/big", { method: "POST", headers: JSON_HEADERS, body: jsonOfLength(LARGE_LIMIT + 1) }));
    expect(over.status).toBe(413);
  });

  it("counts the bytes received, not the Content-Length header", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const response = await server().fetch(
      request("/api/v1/plain", { method: "POST", headers: { "content-type": "text/plain" }, body: stream, duplex: "half" }),
    );
    expect(response.status).toBe(413);
    expect(await problemOf(response)).toMatchObject({ code: "payload_too_large" });
    // 16 KiB chunks against a 64 KiB limit: the stage stops pulling soon after the limit, far from the 1000 chunks offered.
    expect(pulled).toBeLessThan(16);
  });

  it("refuses a declared Content-Length over the limit without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 200) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await server().fetch(
      request("/api/v1/plain", {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) },
        body: stream,
        duplex: "half",
      }),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("answers malformed JSON on a JSON route with 400 bad_request", async () => {
    const app = server();
    for (const body of ["{", '{"note":', "not json", "\uFFFE{}"]) {
      const response = await app.fetch(request("/api/v1/json", { method: "POST", headers: JSON_HEADERS, body }));
      expect(response.status, body).toBe(400);
      expect(await problemOf(response)).toMatchObject({ code: "bad_request", status: 400 });
    }
    const invalidUtf8 = await app.fetch(
      request("/api/v1/json", { method: "POST", headers: JSON_HEADERS, body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }),
    );
    expect(invalidUtf8.status).toBe(400);
  });

  it("leaves a missing body to the validation stage", async () => {
    const response = await server().fetch(request("/api/v1/json", { method: "POST", headers: JSON_HEADERS }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "", code: "invalid_type" }] });
  });

  it("passes well-formed JSON on, and the handler still reads the body", async () => {
    const response = await server().fetch(request("/api/v1/json", { method: "POST", headers: JSON_HEADERS, body: '{"note":"hi"}' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: 13 });
  });

  it("does not parse JSON on a route that declares no request body", async () => {
    const response = await server().fetch(request("/api/v1/plain", { method: "POST", headers: JSON_HEADERS, body: "{" }));
    expect(response.status).toBe(200);
  });

  it("leaves the content-type rule of a browser-facing request to stage 5", async () => {
    const response = await server().fetch(request("/api/v1/json", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }));
    expect(response.status).toBe(403);
    expect(await problemOf(response)).toMatchObject({ code: "cross_site_request" });
  });

  describe("a bearer-authenticated mutation", () => {
    const bearer = { authorization: "Bearer slb_example" };

    it("answers 415 unsupported_media_type when its body is not JSON", async () => {
      const app = server();
      for (const headers of [{ ...bearer, "content-type": "text/plain" }, bearer, { ...bearer, "content-type": "multipart/form-data; boundary=x" }]) {
        const response = await app.fetch(request("/api/v1/json", { method: "POST", headers, body: "hello" }));
        expect(response.status).toBe(415);
        expect(await problemOf(response)).toMatchObject({ code: "unsupported_media_type", status: 415 });
      }
    });

    it("accepts a JSON body, with parameters on the media type", async () => {
      const response = await server().fetch(
        request("/api/v1/json", { method: "POST", headers: { ...bearer, "content-type": "Application/JSON; charset=utf-8" }, body: "{}" }),
      );
      expect(response.status).toBe(200);
    });

    it("does not need a content type when it sends no body", async () => {
      const response = await server().fetch(request("/api/v1/thing", { method: "DELETE", headers: bearer }));
      expect(response.status).toBe(200);
    });

    it("still answers 400 for malformed JSON", async () => {
      const response = await server().fetch(request("/api/v1/json", { method: "POST", headers: { ...bearer, ...JSON_HEADERS }, body: "{" }));
      expect(response.status).toBe(400);
    });

    it("answers 413 before 415 for an oversized body", async () => {
      const response = await server().fetch(
        request("/api/v1/json", { method: "POST", headers: { ...bearer, "content-type": "text/plain" }, body: "a".repeat(DEFAULT_MAX_BODY_BYTES + 1) }),
      );
      expect(response.status).toBe(413);
    });
  });

  it("limits a request that matches no operation as well", async () => {
    const response = await server().fetch(
      request("/api/v1/nowhere", { method: "POST", headers: JSON_HEADERS, body: "a".repeat(DEFAULT_MAX_BODY_BYTES + 1) }),
    );
    expect(response.status).toBe(413);
  });
});
