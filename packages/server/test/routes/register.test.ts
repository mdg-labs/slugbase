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

  it("refuses a declaration of re-authentication that contradicts the rest of the policy, naming the operation", () => {
    const unscoped = {
      method: "post",
      path: "/api/v1/notes/password",
      operationId: "changeNotePassword",
      tag: "notes",
      auth: "account",
      rate: "write",
      reauth: true,
      responses: { 204: emptyResponse("done"), 422: problemResponse("invalid") },
    } as const satisfies OperationDefinition;
    const base = { ...unscoped, scope: "write" } as const;
    const variants: OperationDefinition[] = [
      { ...unscoped, auth: "anonymous" },
      { ...unscoped, auth: "machine" },
      { ...unscoped, auth: "partial" },
      base,
      { ...unscoped, audience: "machine" },
    ];
    for (const operation of variants) {
      const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([operation])));
      expect(error.code).toBe("missing_policy");
      expect(error.message).toContain("changeNotePassword");
    }
  });

  it("refuses a binding whose re-authentication differs from the document's, in either direction", () => {
    const sensitive = defineOperation({
      method: "post",
      path: "/api/v1/notes/password",
      operationId: "changeNotePassword",
      tag: "notes",
      auth: "account",
      rate: "write",
      reauth: true,
      responses: { 204: emptyResponse("done"), 422: problemResponse("invalid") },
    });
    const dropped: OperationDefinition = { ...sensitive, reauth: false };
    const omitted = Object.fromEntries(Object.entries(sensitive).filter(([key]) => key !== "reauth")) as unknown as OperationDefinition;
    for (const operation of [dropped, omitted]) {
      const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([sensitive])));
      expect(error.code).toBe("policy_mismatch");
      expect(error.message).toContain("changeNotePassword");
      expect(error.message).toContain("x-slugbase-reauth");
    }
    const added = refusal(() => compose([moduleOf({ operation: sensitive, ...raw })], documentFor([dropped])));
    expect(added.code).toBe("policy_mismatch");
    expect(added.message).toContain("x-slugbase-reauth");
    expect(() => compose([moduleOf({ operation: omitted, ...raw })], documentFor([omitted]))).not.toThrow();
  });

  it("refuses a re-authentication declaration that is not a boolean", () => {
    const operation = { ...createNote, reauth: "yes" } as unknown as OperationDefinition;
    const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([createNote])));
    expect(error.code).toBe("missing_policy");
    expect(error.message).toContain("reauth");
  });

  it("registers an operation that declares re-authentication on a session-only policy, and the partial policy without it", () => {
    const unscoped = {
      method: "post",
      path: "/api/v1/notes/password",
      operationId: "changeNotePassword",
      tag: "notes",
      auth: "account",
      rate: "write",
      responses: { 204: emptyResponse("done"), 422: problemResponse("invalid") },
    } as const satisfies OperationDefinition;
    const sensitive = defineOperation({ ...unscoped, reauth: true });
    const verify = defineOperation({ ...unscoped, operationId: "verifyNoteCode", path: "/api/v1/notes/verify", auth: "partial" });
    const document = documentFor([sensitive, verify]);
    expect(() => compose([moduleOf(route(sensitive).handle(() => ({ status: 204 })), route(verify).handle(() => ({ status: 204 })))], document)).not.toThrow();
  });

  it("refuses a binding whose idempotency differs from the document's, in either direction", () => {
    const keyed = defineOperation({
      method: "post",
      path: "/api/v1/notes/keyed",
      operationId: "createKeyedNote",
      tag: "notes",
      auth: "member",
      rate: "write",
      idempotency: true,
      responses: { 204: emptyResponse("done"), 409: problemResponse("conflict") },
    });
    const dropped: OperationDefinition = { ...keyed, idempotency: false };
    const omitted = Object.fromEntries(Object.entries(keyed).filter(([key]) => key !== "idempotency")) as unknown as OperationDefinition;
    for (const operation of [dropped, omitted]) {
      const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([keyed])));
      expect(error.code).toBe("policy_mismatch");
      expect(error.message).toContain("createKeyedNote");
      expect(error.message).toContain("x-slugbase-idempotency");
    }
    const added = refusal(() => compose([moduleOf({ operation: keyed, ...raw })], documentFor([omitted])));
    expect(added.code).toBe("policy_mismatch");
    expect(added.message).toContain("x-slugbase-idempotency");
    expect(() => compose([moduleOf(route(keyed).handle(() => ({ status: 204 })))], documentFor([keyed]))).not.toThrow();
  });

  it("refuses an idempotency declaration that is not a boolean or sits on an operation with no account", () => {
    const notBoolean = { ...createNote, idempotency: "yes" } as unknown as OperationDefinition;
    const invalid = refusal(() => compose([moduleOf({ operation: notBoolean, ...raw })], documentFor([createNote])));
    expect(invalid.code).toBe("missing_policy");
    expect(invalid.message).toContain("idempotency");
    for (const auth of ["anonymous", "machine"] as const) {
      const operation: OperationDefinition = { ...createNote, auth, idempotency: true };
      const error = refusal(() => compose([moduleOf({ operation, ...raw })], documentFor([createNote])));
      expect(error.code).toBe("missing_policy");
      expect(error.message).toContain("createNote");
      expect(error.message).toContain("idempotency");
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
