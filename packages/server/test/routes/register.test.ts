import {
  defineOperation,
  emptyResponse,
  getHealth,
  jsonResponse,
  operations,
  problemResponse,
  type OperationDefinition,
} from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CompositionError, createServer, type RouteBinding, type ServerModule } from "../../src/create-server.ts";
import { loadCommittedDocument } from "../../src/routes/committed-document.ts";
import { checkRegistrations, route } from "../../src/routes/register.ts";
import { adapters, documentEntry, documentFor, documentOf, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// The registration path of doc 04 section 1.1 and doc 10 T3, exercised through
// createServer: a route is built from a contract operation and a typed handler,
// and a composition that registers anything else does not start.

const raw = { handler: () => Response.json({}) };

function compose(modules: readonly ServerModule[], document?: ReturnType<typeof documentFor>) {
  return createServer({
    config: serverConfig(),
    adapters: adapters(),
    modules,
    ...(document === undefined ? {} : { openApiDocument: document }),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
}

function moduleOf(...routes: RouteBinding[]): ServerModule {
  return { name: "routes", register: () => ({ routes }) };
}

function refusal(run: () => unknown): CompositionError {
  try {
    run();
  } catch (error) {
    if (error instanceof CompositionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the composition to be refused");
}

const Note = z.strictObject({ id: z.string(), title: z.string() });
const Create = z.strictObject({ title: z.string() });

const createNote = defineOperation({
  method: "post",
  path: "/api/v1/notes/{id}",
  operationId: "createNote",
  tag: "notes",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: z.object({ id: z.string() }), query: z.object({ draft: z.enum(["true", "false"]).optional() }), body: Create },
  responses: {
    201: jsonResponse("created", Note, { headers: { Location: { description: "where it lives", schema: z.string() } } }),
    204: emptyResponse("nothing to say"),
    422: problemResponse("invalid"),
  },
});

describe("route: a handler typed from its operation", () => {
  it("receives the parsed params, query and body and answers with a declared response", () => {
    route(createNote).handle((request) => {
      const id: string = request.params.id;
      const draft: "true" | "false" | undefined = request.query.draft;
      const title: string = request.body.title;
      return { status: 201, body: { id, title: draft ?? title }, headers: { Location: `/api/v1/notes/${id}` } };
    });
    expect(true).toBe(true);
  });

  it("does not compile when the handler returns the wrong shape", () => {
    // @ts-expect-error #44 the body must carry the title the schema requires
    route(createNote).handle(() => ({ status: 201, body: { id: "1" }, headers: { Location: "/x" } }));
    // @ts-expect-error #44 a field of the wrong type
    route(createNote).handle(() => ({ status: 201, body: { id: 1, title: "t" }, headers: { Location: "/x" } }));
    // @ts-expect-error #44 a status the operation does not declare
    route(createNote).handle(() => ({ status: 200, body: { id: "1", title: "t" } }));
    // @ts-expect-error #44 a problem is thrown, not returned
    route(createNote).handle(() => ({ status: 422, body: {} }));
    // @ts-expect-error #44 the declared Location header is required
    route(createNote).handle(() => ({ status: 201, body: { id: "1", title: "t" } }));
    // @ts-expect-error #44 an empty response carries no body
    route(createNote).handle(() => ({ status: 204, body: { id: "1", title: "t" } }));
    expect(true).toBe(true);
  });

  it("does not compile when the handler reads what the operation does not declare", () => {
    route(getHealth).handle((request) => {
      // @ts-expect-error #44 getHealth declares no body
      expect(request.body).toBeUndefined();
      return { status: 200, body: { status: "ok" } };
    });
    route(createNote).handle((request) => {
      // @ts-expect-error #44 the body has no such field
      expect(request.body.nope).toBeUndefined();
      return { status: 204 };
    });
    expect(true).toBe(true);
  });

  it("builds the binding of its operation, with the multipart and marketing options only when given", () => {
    const binding = route(getHealth).handle(() => ({ status: 200, body: { status: "ok" } }));
    expect(binding.operation).toBe(getHealth);
    expect(Object.keys(binding).sort()).toEqual(["handler", "operation"]);
    expect(route(getHealth).handle(() => ({ status: 200, body: { status: "ok" } }), { acceptsMultipart: true }).acceptsMultipart).toBe(true);
  });
});

describe("the registration check", () => {
  const committed = loadCommittedDocument();

  it("accepts every operation the contract declares, against the committed document", () => {
    const bindings = operations.map((operation): RouteBinding => ({ operation, ...raw }));
    expect(bindings.length).toBeGreaterThan(0);
    expect(checkRegistrations(bindings, committed)).toBeUndefined();
  });

  it("serves the contract operations the server registers itself on a server that names no document", async () => {
    const server = compose([]);
    const response = await server.fetch(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("refuses a module that registers an operation the server registers itself", () => {
    const error = refusal(() => compose([moduleOf(route(getHealth).handle(() => ({ status: 200, body: { status: "ok" } })))]));
    expect(error.code).toBe("duplicate_route");
    expect(error.message).toContain("getHealth");
  });

  it("refuses an operation without a policy, naming it, whatever the document says", () => {
    const noAuth = { ...createNote, auth: undefined } as unknown as OperationDefinition;
    const noRate = { ...createNote, rate: undefined } as unknown as OperationDefinition;
    const unknownAuth = { ...createNote, auth: "everyone" } as unknown as OperationDefinition;
    for (const operation of [noAuth, noRate, unknownAuth]) {
      const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([createNote])));
      expect(error.code).toBe("missing_policy");
      expect(error.message).toContain("createNote");
    }
  });

  it("refuses an operation that is not in the committed document, naming it", () => {
    const stray = defineOperation({
      method: "get",
      path: "/api/v1/stray",
      operationId: "getStray",
      tag: "test",
      auth: "anonymous",
      rate: "none",
      responses: { 200: jsonResponse("ok", z.strictObject({})), 404: problemResponse("missing") },
    });
    const error = refusal(() => compose([moduleOf({ operation: stray, ...raw })]));
    expect(error.code).toBe("undocumented_operation");
    expect(error.message).toContain("getStray");
  });

  it("refuses an operation registered with a hand-written policy that differs from the contract", () => {
    const variants: [string, OperationDefinition][] = [
      ["x-slugbase-auth", { ...createNote, auth: "owner" }],
      ["x-slugbase-rate", { ...createNote, rate: "read" }],
      ["x-slugbase-rate", { ...createNote, rate: "none" }],
      ["x-slugbase-scope", { ...createNote, scope: "read" }],
      ["x-slugbase-entitlement", { ...createNote, entitlement: "sharing.teams" }],
      ["x-slugbase-audience", { ...createNote, audience: "machine" }],
    ];
    for (const [extension, operation] of variants) {
      const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([createNote])));
      expect(error.code).toBe("policy_mismatch");
      expect(error.message).toContain(operation.operationId);
      expect(error.message).toContain(extension);
    }
  });

  it("refuses a route that moves a documented operation to another path or method", () => {
    const document = documentFor([createNote]);
    const moved = refusal(() => compose([moduleOf({ operation: { ...createNote, path: "/api/v1/moved/{id}" }, ...raw })], document));
    expect(moved.code).toBe("policy_mismatch");
    expect(moved.message).toContain("createNote");
    const method = refusal(() => compose([moduleOf({ operation: { ...createNote, method: "put" }, ...raw })], document));
    expect(method.code).toBe("policy_mismatch");
  });

  it("checks the operations of every module the same way", () => {
    const other = { ...createNote, operationId: "updateNote", path: "/api/v1/notes/{id}/rename", auth: "member" } as const;
    const fine = moduleOf(route(createNote).handle(() => ({ status: 204 })));
    const loosened: ServerModule = { name: "cloud", register: () => ({ routes: [{ operation: { ...other, auth: "anonymous" }, ...raw }] }) };
    const error = refusal(() => compose([fine, loosened], documentFor([createNote, other])));
    expect(error.code).toBe("policy_mismatch");
    expect(error.message).toContain("updateNote");
  });

  it("refuses an operation registered twice, naming it", () => {
    const once = route(createNote).handle(() => ({ status: 204 }));
    const document = documentFor([createNote]);
    const error = refusal(() => compose([moduleOf(once, once)], document));
    expect(error.code).toBe("duplicate_route");
    expect(error.message).toContain("createNote");
    const split = refusal(() => compose([moduleOf(once), { name: "again", register: () => ({ routes: [once] }) }], document));
    expect(split.code).toBe("duplicate_route");
    expect(split.message).toContain("createNote");
  });

  it("registers an operation the composition's own document declares", () => {
    const document = documentFor([createNote]);
    expect(() => compose([moduleOf(route(createNote).handle(() => ({ status: 204 })))], document)).not.toThrow();
    expect(documentOf([moduleOf(route(createNote).handle(() => ({ status: 204 })))])).toEqual(document);
    expect(refusal(() => compose([moduleOf(route(createNote).handle(() => ({ status: 204 })))], documentFor([]))).code).toBe("undocumented_operation");
  });

  it("reads the policy from the document even when the operation object carries the same operationId", () => {
    const document = documentFor([getHealth]);
    const entry = { ...documentEntry(getHealth), "x-slugbase-auth": "owner" };
    const tampered = { paths: { "/health": { get: entry } } };
    expect(checkRegistrations([{ operation: getHealth, ...raw }], document)).toBeUndefined();
    expect(checkRegistrations([{ operation: getHealth, ...raw }], tampered)?.code).toBe("policy_mismatch");
  });

  it("is refused before the server listens, and the pool it opened is closed", () => {
    const database = fakeDatabase();
    expect(() =>
      createServer({
        config: serverConfig(),
        adapters: adapters(),
        modules: [moduleOf({ operation: { ...createNote, auth: "owner" }, ...raw })],
        openApiDocument: documentFor([createNote]),
        migrations: [],
        logger: recordingLogger(),
        database,
      }),
    ).toThrow(CompositionError);
    expect(database.closed.count).toBe(1);
  });
});
