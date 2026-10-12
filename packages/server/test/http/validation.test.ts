import { defineOperation, emptyResponse, jsonResponse, problemResponse } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer, type ModuleContribution, type RouteBinding, type ServerModule } from "../../src/create-server.ts";
import { route } from "../../src/routes/register.ts";
import { adapters, documentOf, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// Stage 8 of the chain (doc 01 section 4, doc 04 section 2.3): the request is
// parsed with the operation's schemas, unknown fields are a 422, and a handler
// is reached only with what the schemas returned.

const APP_ORIGIN = serverConfig().APP_ORIGIN;
const JSON_HEADERS = { "content-type": "application/json", origin: APP_ORIGIN };

const Created = z.strictObject({ id: z.string(), title: z.string(), tags: z.array(z.string()), page: z.number() });
const CreateBody = z.strictObject({
  title: z.string().trim().min(1).max(20),
  nested: z.strictObject({ level: z.number().int() }).optional(),
});

const createNote = defineOperation({
  method: "post",
  path: "/api/v1/notes/{id}",
  operationId: "createNote",
  tag: "test",
  auth: "anonymous",
  rate: "none",
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ page: z.coerce.number().int().min(1).default(1), tag: z.union([z.string(), z.array(z.string())]).optional() }),
    body: CreateBody,
  },
  responses: { 201: jsonResponse("created", Created), 422: problemResponse("invalid") },
});

const upload = defineOperation({
  method: "post",
  path: "/api/v1/upload",
  operationId: "uploadFile",
  tag: "test",
  auth: "anonymous",
  rate: "none",
  request: { body: z.strictObject({ never: z.string() }) },
  responses: { 204: emptyResponse("stored"), 422: problemResponse("invalid") },
});

const receiveEvent = defineOperation({
  method: "post",
  path: "/api/v1/events",
  operationId: "receiveEvent",
  tag: "test",
  auth: "machine",
  audience: "machine",
  rate: "none",
  request: { body: z.strictObject({ kind: z.string() }) },
  responses: { 204: emptyResponse("accepted"), 422: problemResponse("invalid") },
});

const ID = "0192f1c4-7b5e-7a1d-9c3e-5a1b2c3d4e5f";

function setup() {
  const reached: unknown[] = [];
  const routes: RouteBinding[] = [
    route(createNote).handle((request) => {
      reached.push(request);
      return {
        status: 201,
        body: {
          id: request.params.id,
          title: request.body.title,
          tags: [request.query.tag ?? []].flat(),
          page: request.query.page,
        },
      };
    }),
    route(receiveEvent).handle((request) => {
      reached.push(request);
      return { status: 204 };
    }),
    route(upload).handle(
      (request) => {
        reached.push(request);
        return { status: 204 };
      },
      { acceptsMultipart: true },
    ),
  ];
  const module: ServerModule = { name: "notes", register: (): ModuleContribution => ({ routes }) };
  const server = createServer({
    config: serverConfig(),
    adapters: adapters(),
    modules: [module],
    openApiDocument: documentOf([module]),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
  return { server, reached };
}

function post(path: string, body: string | undefined, headers: Record<string, string> = JSON_HEADERS): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body }) });
}

async function problemOf(response: Response) {
  return (await response.json()) as { code: string; status: number; errors?: { path: string; code: string }[]; detail: string };
}

describe("the validation stage", () => {
  it("hands the handler what the schemas returned, not what the caller sent", async () => {
    const { server, reached } = setup();
    const response = await server.fetch(post(`/api/v1/notes/${ID}?page=3&tag=a&tag=b`, JSON.stringify({ title: "  padded  " })));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: ID, title: "padded", tags: ["a", "b"], page: 3 });
    expect(reached).toHaveLength(1);
  });

  it("applies the defaults of the query schema", async () => {
    const { server } = setup();
    const response = await server.fetch(post(`/api/v1/notes/${ID}`, JSON.stringify({ title: "t" })));
    expect(await response.json()).toMatchObject({ page: 1, tags: [] });
  });

  it("rejects an unknown body field with 422 validation_failed and names its path and code", async () => {
    const { server, reached } = setup();
    const response = await server.fetch(post(`/api/v1/notes/${ID}`, JSON.stringify({ title: "t", admin: true })));
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const problem = await problemOf(response);
    expect(problem).toMatchObject({ code: "validation_failed", status: 422 });
    expect(problem.errors).toEqual([{ path: "admin", code: "unrecognized_keys" }]);
    expect(reached).toHaveLength(0);
  });

  it("rejects an unknown field inside a nested object, with the full path", async () => {
    const { server } = setup();
    const response = await server.fetch(post(`/api/v1/notes/${ID}`, JSON.stringify({ title: "t", nested: { level: 1, extra: 1 } })));
    expect((await problemOf(response)).errors).toEqual([{ path: "nested.extra", code: "unrecognized_keys" }]);
  });

  it("lists every failing field across params, query and body in one answer", async () => {
    const { server, reached } = setup();
    const response = await server.fetch(post("/api/v1/notes/not-a-uuid?page=0&stray=1", JSON.stringify({ title: "", nested: { level: "x" } })));
    expect(response.status).toBe(422);
    const errors = (await problemOf(response)).errors ?? [];
    expect(errors).toEqual(
      expect.arrayContaining([
        { path: "id", code: "invalid_format" },
        { path: "page", code: "too_small" },
        { path: "stray", code: "unrecognized_keys" },
        { path: "title", code: "too_small" },
        { path: "nested.level", code: "invalid_type" },
      ]),
    );
    expect(reached).toHaveLength(0);
  });

  it("rejects a missing body on an operation that declares one", async () => {
    const { server } = setup();
    const response = await server.fetch(post(`/api/v1/notes/${ID}`, undefined));
    expect(response.status).toBe(422);
    expect((await problemOf(response)).errors).toEqual([{ path: "", code: "invalid_type" }]);
  });

  it("names the fields that failed and never echoes a value the caller sent", async () => {
    const { server } = setup();
    const response = await server.fetch(post(`/api/v1/notes/${ID}?page=pw-in-query`, JSON.stringify({ title: 7, extra: "pw-in-body" })));
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain("pw-in-query");
    expect(text).not.toContain("pw-in-body");
    expect(text).toContain("extra");
  });

  it("answers 400 bad_request for a body that is not JSON on a route that stage 3 does not guard", async () => {
    const { server, reached } = setup();
    const response = await server.fetch(post("/api/v1/events", "{", { "content-type": "application/json" }));
    expect(response.status).toBe(400);
    expect(await problemOf(response)).toMatchObject({ code: "bad_request" });
    expect(reached).toHaveLength(0);
  });

  it("answers 415 for a body that does not declare JSON on a route exempt from the cross-site rule", async () => {
    const { server, reached } = setup();
    const response = await server.fetch(post("/api/v1/events", '{"kind":"x"}', { "content-type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(await problemOf(response)).toMatchObject({ code: "unsupported_media_type" });
    expect(reached).toHaveLength(0);
  });

  it("leaves a multipart route's body to its handler", async () => {
    const { server, reached } = setup();
    const response = await server.fetch(
      post("/api/v1/upload", "--b\r\ncontent-disposition: form-data; name=file\r\n\r\nx\r\n--b--", {
        origin: APP_ORIGIN,
        "content-type": "multipart/form-data; boundary=b",
      }),
    );
    expect(response.status).toBe(204);
    expect(reached).toHaveLength(1);
  });

  it("does not run for a request that matches no operation", async () => {
    const { server } = setup();
    const response = await server.fetch(post("/api/v1/unknown", "{", JSON_HEADERS));
    expect(response.status).toBe(404);
  });
});
