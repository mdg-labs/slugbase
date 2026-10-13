import { describe, expect, it } from "vitest";
import {
  classifyOperations,
  runApiMatrix,
  type ApiCall,
  type ApiResponse,
  type FixtureIdentifier,
} from "../src/tenancy.ts";
import { B_BOOKMARK_SHARED, B_BOOKMARK_UNSHARED, B_ID, B_MARKER, B_MEMBER, B_TEAM, documentOf, memoryFixture } from "./support/memory-fixture.ts";

// The runner's API mode and the classifier, against stub request functions and
// an in-memory fixture (doc 08 section 3.3): what each stub does is the failure
// the matrix has to see.

const BOOKMARK_DOCUMENT = documentOf([
  { operationId: "getBookmark", path: "/api/v1/bookmarks/{bookmarkId}", auth: "member" },
]);
const MAPPING = { bookmarkId: "bookmark" } as const;

const notFound = (call: ApiCall): ApiResponse => ({
  status: 404,
  body: { type: "about:blank", title: "Not Found", status: 404, instance: call.url },
});

const refused = (call: ApiCall): ApiResponse => ({
  status: 403,
  body: { type: "about:blank", title: "Forbidden", status: 403, instance: call.url },
});

const RANK: Readonly<Record<string, number>> = { member: 1, admin: 2, owner: 3 };

/** What the chain answers: 403 to a principal below the policy of the operation, 404 to the others. */
const answerByPolicy = (call: ApiCall): ApiResponse =>
  (RANK[call.principal.role] ?? 0) < (RANK[call.operation.policy] ?? 0) ? refused(call) : notFound(call);

describe("classifyOperations", () => {
  it("places each policy in one of the four kinds and counts them", () => {
    const result = classifyOperations(
      documentOf([
        { operationId: "a", path: "/a/{id}", auth: "member" },
        { operationId: "b", path: "/b", auth: "admin" },
        { operationId: "c", path: "/c", auth: "owner", method: "delete" },
        { operationId: "d", path: "/d", auth: "account" },
        { operationId: "e", path: "/e", auth: "anonymous" },
        { operationId: "f", path: "/f", auth: "instanceAdmin" },
        { operationId: "g", path: "/g", auth: "machine" },
      ]),
    );
    expect(result.problems).toEqual([]);
    expect(result.summary).toEqual({
      total: 7,
      byKind: { "tenant-scoped": 3, "account-level": 1, anonymous: 1, process: 2 },
    });
    expect(result.operations.find((operation) => operation.operationId === "a")?.pathParameters).toEqual(["id"]);
  });

  it("reports an operation with a missing or unknown policy, and counts it", () => {
    const result = classifyOperations(
      documentOf([
        { operationId: "noPolicy", path: "/x", auth: undefined },
        { operationId: "oddPolicy", path: "/y", auth: "everyone" },
      ]),
    );
    expect(result.operations).toEqual([]);
    expect(result.summary.total).toBe(2);
    expect(result.problems.map((problem) => problem.subject).join("\n")).toContain("noPolicy");
    expect(result.problems.map((problem) => problem.subject).join("\n")).toContain("oddPolicy");
  });

  it("reports a document without paths", () => {
    expect(classifyOperations({}).problems).toHaveLength(1);
  });
});

describe("API mode", () => {
  it("passes when every attempt answers 404 and B is unchanged, and counts the attempts", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: (call) => Promise.resolve(notFound(call)),
    });
    expect(report.failures).toEqual([]);
    // three principals of A against the two bookmarks of B
    expect(report.attempts).toBe(6);
    expect(report.classified.byKind["tenant-scoped"]).toBe(1);
  });

  it("targets every identifier of B as every principal of A", async () => {
    const seen: string[] = [];
    await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: (call) => {
        seen.push(`${call.principal.role} ${call.url}`);
        return Promise.resolve(notFound(call));
      },
    });
    expect(seen.sort()).toEqual(
      ["owner", "admin", "member"]
        .flatMap((role) => [B_BOOKMARK_SHARED, B_BOOKMARK_UNSHARED].map((id) => `${role} /api/v1/bookmarks/${id}`))
        .sort(),
    );
  });

  it("does not send a call for an account-level, anonymous or process operation", async () => {
    let calls = 0;
    const report = await runApiMatrix({
      document: documentOf([
        { operationId: "me", path: "/api/v1/me", auth: "account" },
        { operationId: "health", path: "/health", auth: "anonymous" },
        { operationId: "admin", path: "/api/v1/instance", auth: "instanceAdmin" },
      ]),
      fixture: memoryFixture(),
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 200 });
      },
    });
    expect(calls).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.classified.byKind["tenant-scoped"]).toBe(0);
    expect(report.classified.total).toBe(3);
  });

  it("fails an answer of 403, which discloses that the row exists", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: () => Promise.resolve({ status: 403, body: { title: "Forbidden" } }),
    });
    expect(report.failures).toHaveLength(6);
    expect(report.failures.every((failure) => failure.kind === "unexpected_status")).toBe(true);
    expect(report.failures[0]?.subject).toContain("getBookmark");
    expect(report.failures[0]?.detail).toContain("403");
  });

  describe("by the policy of the operation", () => {
    const documentOfPolicy = (auth: string): unknown =>
      documentOf([{ operationId: "getWidget", path: "/api/v1/widgets/{widgetId}", auth }]);
    const answerByRole = (below: readonly string[]) => (call: ApiCall) =>
      Promise.resolve(below.includes(call.principal.role) ? refused(call) : notFound(call));
    const run = (auth: string, request: (call: ApiCall) => Promise<ApiResponse>) =>
      runApiMatrix({ document: documentOfPolicy(auth), fixture: memoryFixture(), mapping: { widgetId: "bookmark" }, request });

    it("expects 403 below an admin policy and 404 at or above it, and still calls every principal", async () => {
      const seen: string[] = [];
      const report = await run("admin", (call) => {
        seen.push(call.principal.role);
        return answerByRole(["member"])(call);
      });
      expect(report.failures).toEqual([]);
      // three principals of A against the two bookmarks of B
      expect(report.attempts).toBe(6);
      expect([...new Set(seen)].sort()).toEqual(["admin", "member", "owner"]);
    });

    it("expects 403 for a member and an admin on an owner policy", async () => {
      const report = await run("owner", answerByRole(["member", "admin"]));
      expect(report.failures).toEqual([]);
    });

    it("keeps 404 for every principal on a member policy", async () => {
      const report = await run("member", answerByRole([]));
      expect(report.failures).toEqual([]);
    });

    it("fails a 404 below the policy: the handler was reached", async () => {
      const report = await run("admin", (call) => Promise.resolve(notFound(call)));
      expect(report.failures.map((failure) => failure.kind)).toEqual(["unexpected_status", "unexpected_status"]);
      expect(report.failures.every((failure) => failure.detail.startsWith("as member of A"))).toBe(true);
      expect(report.failures[0]?.detail).toContain("expected 403");
    });

    it("fails a 403 at or above the policy", async () => {
      const report = await run("admin", answerByRole(["member", "admin"]));
      expect(report.failures).toHaveLength(2);
      expect(report.failures.every((failure) => failure.detail.startsWith("as admin of A"))).toBe(true);
      expect(report.failures[0]?.detail).toContain("expected 404");
    });

    it("fails a 200 that returns the row of B to a principal at the policy", async () => {
      const report = await run("admin", (call) =>
        call.principal.role === "member" ? Promise.resolve(refused(call)) : Promise.resolve({ status: 200, body: { id: call.url } }),
      );
      expect(report.failures).toHaveLength(4);
      expect(report.failures.every((failure) => failure.kind === "unexpected_status" && failure.detail.includes("expected 404"))).toBe(true);
    });

    it("still fails a refusal whose body quotes content of B", async () => {
      const report = await run("admin", (call) =>
        Promise.resolve(call.principal.role === "member" ? { status: 403, body: { detail: B_MARKER } } : notFound(call)),
      );
      expect(report.failures.map((failure) => failure.kind)).toEqual(["leaked_name", "leaked_name"]);
    });
  });

  it("fails a 404 whose body names another row of B", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: () => Promise.resolve({ status: 404, body: { detail: `no bookmark; the neighbour is ${B_BOOKMARK_UNSHARED}` } }),
    });
    expect(report.failures.some((failure) => failure.kind === "leaked_name" && failure.detail.includes(B_BOOKMARK_UNSHARED))).toBe(true);
  });

  it("fails a 404 whose body quotes content of B", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: () => Promise.resolve({ status: 404, body: `Not found: ${B_MARKER.toUpperCase()}` }),
    });
    expect(report.failures.some((failure) => failure.kind === "leaked_name" && failure.detail.includes(B_MARKER))).toBe(true);
  });

  it("does not count the id the request carried, which a problem document repeats", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: (call) => Promise.resolve({ status: 404, body: { detail: `bookmark ${call.targets["bookmarkId"] ?? ""} not found` } }),
    });
    expect(report.failures).toEqual([]);
  });

  it("fails an answer of 200 that returns the row of B", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: (call) =>
        Promise.resolve({ status: 200, body: { id: call.targets["bookmarkId"], workspaceId: B_ID, title: B_MARKER } }),
    });
    const kinds = new Set(report.failures.map((failure) => failure.kind));
    expect(kinds).toEqual(new Set(["unexpected_status", "leaked_name"]));
  });

  it("fails an attempt that changes the checksum of B, also when it answers 404", async () => {
    const fixture = memoryFixture();
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "deleteBookmark", method: "delete", path: "/api/v1/bookmarks/{bookmarkId}", auth: "member" }]),
      fixture,
      mapping: MAPPING,
      request: (call) => {
        if (call.principal.role === "admin") {
          fixture.touchB();
        }
        return Promise.resolve(notFound(call));
      },
    });
    const changed = report.failures.filter((failure) => failure.kind === "workspace_changed");
    expect(changed).toHaveLength(2);
    expect(changed.every((failure) => failure.detail.includes("as admin of A"))).toBe(true);
  });

  it("fails a request that throws rather than skipping it", async () => {
    const report = await runApiMatrix({
      document: BOOKMARK_DOCUMENT,
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: () => Promise.reject(new Error("connection refused")),
    });
    expect(report.failures).toHaveLength(6);
    expect(report.failures[0]).toMatchObject({ kind: "request_failed" });
    expect(report.failures[0]?.detail).toContain("connection refused");
  });

  it("fails an operation whose path parameter has no mapping, naming the operation", async () => {
    let calls = 0;
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "getWidget", path: "/api/v1/widgets/{widgetId}", auth: "admin" }]),
      fixture: memoryFixture(),
      mapping: MAPPING,
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 404 });
      },
    });
    expect(calls).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ mode: "api", kind: "unmapped_parameter" });
    expect(report.failures[0]?.subject).toContain("getWidget");
    expect(report.failures[0]?.detail).toContain("widgetId");
  });

  it("prefers the mapping of an operation to the one of the parameter", async () => {
    const seen: string[] = [];
    await runApiMatrix({
      document: documentOf([{ operationId: "getTeam", path: "/api/v1/teams/{id}", auth: "member" }]),
      fixture: memoryFixture(),
      mapping: { id: "bookmark", "getTeam.id": "team" },
      request: (call) => {
        seen.push(call.url);
        return Promise.resolve(notFound(call));
      },
    });
    expect([...new Set(seen)]).toEqual(["/api/v1/teams/0192f3a0-3333-7000-8000-0000000000b4"]);
  });

  it("fails when B holds no identifier of the mapped kind", async () => {
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "getTag", path: "/api/v1/tags/{tagId}", auth: "member" }]),
      fixture: memoryFixture(),
      mapping: { tagId: "tag" },
      request: (call) => Promise.resolve(notFound(call)),
    });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ kind: "no_target" });
  });

  it("fails an operation it cannot classify", async () => {
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "mystery", path: "/api/v1/mystery", auth: undefined }]),
      fixture: memoryFixture(),
      request: () => Promise.resolve({ status: 404 }),
    });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ kind: "unclassified_operation" });
    expect(report.failures[0]?.subject).toContain("mystery");
  });

  it("substitutes each identifier URL-encoded", async () => {
    const identifiers: FixtureIdentifier[] = [{ kind: "slug", id: "a b/c" }];
    const fixture = { ...memoryFixture(), b: { ...memoryFixture().b, identifiers } };
    const seen: string[] = [];
    await runApiMatrix({
      document: documentOf([{ operationId: "goSlug", path: "/api/v1/slugs/{slug}", auth: "member" }]),
      fixture,
      mapping: { slug: "slug" },
      request: (call) => {
        seen.push(call.url);
        return Promise.resolve(notFound(call));
      },
    });
    expect(seen[0]).toBe("/api/v1/slugs/a%20b%2Fc");
  });
});

// Under D11 the workspace is never in the path, so an identifier of B reaches
// an operation through its query or its body as well.
describe("API mode, query and body inputs", () => {
  const uuid = { type: "string", format: "uuid" };
  const json = (schema: unknown): unknown => ({ content: { "application/json": { schema } } });
  const transfer = {
    operationId: "transferOwnership",
    method: "post",
    path: "/api/v1/workspace/transfer-ownership",
    auth: "owner",
    requestBody: json({ type: "object", properties: { accountId: uuid }, required: ["accountId"] }),
  };
  const invite = {
    operationId: "createInvitation",
    method: "post",
    path: "/api/v1/invitations",
    auth: "admin",
    requestBody: json({
      type: "object",
      properties: { email: { type: "string", format: "email" }, teamIds: { type: "array", items: uuid } },
    }),
  };
  const audit = {
    operationId: "listAuditEvents",
    path: "/api/v1/audit-events",
    auth: "admin",
    parameters: [
      { name: "entityId", in: "query", schema: uuid },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ],
  };
  const mapping = { accountId: "member", "teamIds[]": "team", "listAuditEvents.entityId": "bookmark" } as const;

  it("classifies the identifier-carrying inputs of a tenant-scoped operation", () => {
    const [operation] = classifyOperations(documentOf([invite])).operations;
    expect(operation?.inputs).toEqual([{ location: "body", name: "teamIds[]", segments: ["teamIds", "[]"] }]);
    expect(operation?.unwalkable).toEqual([]);
    const [query] = classifyOperations(documentOf([audit])).operations;
    expect(query?.inputs.map((input) => `${input.location}:${input.name}`)).toEqual(["query:entityId"]);
  });

  it("carries an identifier of B in the body and the query of each call", async () => {
    const calls: ApiCall[] = [];
    const report = await runApiMatrix({
      document: documentOf([transfer, invite, audit]),
      fixture: memoryFixture(),
      mapping,
      request: (call) => {
        calls.push(call);
        return Promise.resolve(answerByPolicy(call));
      },
    });
    expect(report.failures).toEqual([]);
    const of = (operationId: string): ApiCall[] => calls.filter((call) => call.operation.operationId === operationId);
    expect(of("transferOwnership").map((call) => call.body)).toEqual([{ accountId: B_MEMBER }, { accountId: B_MEMBER }, { accountId: B_MEMBER }]);
    expect(of("createInvitation").every((call) => JSON.stringify(call.body) === JSON.stringify({ teamIds: [B_TEAM] }))).toBe(true);
    const queries = of("listAuditEvents");
    expect(queries.map((call) => call.query["entityId"])).toEqual(
      ["owner", "admin", "member"].flatMap(() => [B_BOOKMARK_SHARED, B_BOOKMARK_UNSHARED]),
    );
    expect(queries.every((call) => call.url === `/api/v1/audit-events?entityId=${call.query["entityId"] as string}`)).toBe(true);
    expect(report.attempts).toBe(3 + 3 + 6);
  });

  it("fails a 200 or a 403 for an operation that takes its identifier in the body or the query", async () => {
    const report = await runApiMatrix({
      document: documentOf([transfer, audit]),
      fixture: memoryFixture(),
      mapping,
      request: (call) => Promise.resolve({ status: call.operation.operationId === "transferOwnership" ? 200 : 403 }),
    });
    expect(new Set(report.failures.map((failure) => failure.kind))).toEqual(new Set(["unexpected_status"]));
    // the 200 of the owner operation fails for all three principals; the 403 of the admin operation only for the two at or above its policy
    expect(report.failures).toHaveLength(3 + 2 * 2);
  });

  it("fails an operation whose body input has no mapping, naming the operation and the input", async () => {
    let calls = 0;
    const report = await runApiMatrix({
      document: documentOf([transfer]),
      fixture: memoryFixture(),
      mapping: {},
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 404 });
      },
    });
    expect(calls).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ mode: "api", kind: "unmapped_parameter" });
    expect(report.failures[0]?.subject).toContain("transferOwnership");
    expect(report.failures[0]?.detail).toContain('body input "accountId"');
  });

  it("fails an operation whose query input has no mapping, naming the operation and the input", async () => {
    const report = await runApiMatrix({
      document: documentOf([audit]),
      fixture: memoryFixture(),
      mapping: {},
      request: () => Promise.resolve({ status: 404 }),
    });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.subject).toContain("listAuditEvents");
    expect(report.failures[0]?.detail).toContain('query input "entityId"');
  });

  it("takes any uuid-formatted input, whatever its name, and leaves other inputs alone", () => {
    const operation = {
      operationId: "moveBookmark",
      method: "post",
      path: "/api/v1/move",
      auth: "member",
      parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
      requestBody: json({ type: "object", properties: { target: uuid, label: { type: "string" } } }),
    };
    const [classified] = classifyOperations(documentOf([operation])).operations;
    expect(classified?.inputs.map((input) => input.name)).toEqual(["target"]);
  });

  it("walks references, nested objects, arrays of objects and allOf", () => {
    const document = documentOf(
      [
        {
          operationId: "assign",
          method: "post",
          path: "/api/v1/assign",
          auth: "admin",
          parameters: [{ $ref: "#/components/parameters/Owner" }],
          requestBody: { $ref: "#/components/requestBodies/Assign" },
        },
      ],
      {
        parameters: { Owner: { name: "ownerId", in: "query", schema: { type: "string" } } },
        requestBodies: {
          Assign: json({
            allOf: [
              { type: "object", properties: { members: { type: "array", items: { $ref: "#/components/schemas/Member" } } } },
              { type: "object", properties: { folderId: { type: "string" } } },
            ],
          }),
        },
        schemas: { Member: { type: "object", properties: { accountId: uuid }, additionalProperties: false } },
      },
    );
    const [operation] = classifyOperations(document).operations;
    expect(operation?.unwalkable).toEqual([]);
    expect(operation?.inputs.map((input) => `${input.location}:${input.name}`).sort()).toEqual([
      "body:folderId",
      "body:members[].accountId",
      "query:ownerId",
    ]);
  });

  it.each([
    ["a body without a schema", { content: { "application/json": {} } }, "no schema"],
    ["a body without content", { description: "none" }, "no content"],
    ["an unresolved reference", json({ $ref: "#/components/schemas/Missing" }), "cannot be resolved"],
    ["a free-form object", json({ type: "object" }), "free-form object"],
    ["a schema that accepts anything", json({}), "accepts anything"],
    ["an array without items", json({ type: "object", properties: { ids: { type: "array" } } }), "without an items"],
    ["a map of identifiers", json({ type: "object", additionalProperties: { type: "string", format: "uuid" } }), "arbitrary keys"],
  ])("fails an operation whose request body cannot be walked: %s", async (_name, requestBody, reason) => {
    let calls = 0;
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "opaque", method: "post", path: "/api/v1/opaque", auth: "member", requestBody }]),
      fixture: memoryFixture(),
      mapping,
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 404 });
      },
    });
    expect(calls).toBe(0);
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unwalkable_input"]);
    expect(report.failures[0]?.subject).toContain("opaque");
    expect(report.failures[0]?.detail).toContain(reason);
  });

  // What Zod emits, with the generator's options, for z.record(z.uuid(), ...)
  // and z.looseRecord with regex keys: the keys are identifiers, and they sit in
  // propertyNames or patternProperties, not in properties.
  it.each([
    [
      "a map keyed by identifiers (propertyNames)",
      json({
        type: "object",
        properties: { positions: { type: "object", propertyNames: { type: "string", format: "uuid" }, additionalProperties: { type: "number" } } },
        required: ["positions"],
        additionalProperties: false,
      }),
      "propertyNames",
    ],
    [
      "a map keyed by a pattern (patternProperties)",
      json({
        type: "object",
        properties: { moves: { type: "object", patternProperties: { "^[0-9a-f-]{36}$": { type: "string", format: "uuid" } }, additionalProperties: false } },
        additionalProperties: false,
      }),
      "patternProperties",
    ],
    ["a tuple (prefixItems)", json({ type: "array", prefixItems: [{ type: "string", format: "uuid" }], items: { type: "number" } }), "prefixItems"],
    ["a conditional (if/then)", json({ type: "object", properties: {}, if: { properties: {} }, then: { properties: {} }, additionalProperties: false }), '"if"'],
    ["a negation (not)", json({ type: "object", properties: {}, not: { required: ["accountId"] }, additionalProperties: false }), '"not"'],
    ["contains", json({ type: "array", items: { type: "number" }, contains: { type: "string", format: "uuid" } }), "contains"],
    [
      "dependentSchemas",
      json({ type: "object", properties: { a: { type: "number" } }, dependentSchemas: { a: { properties: {} } }, additionalProperties: false }),
      "dependentSchemas",
    ],
    [
      "unevaluatedProperties",
      json({ type: "object", properties: { a: { type: "number" } }, unevaluatedProperties: { type: "string", format: "uuid" } }),
      "unevaluatedProperties",
    ],
    ["unevaluatedItems", json({ type: "array", items: { type: "number" }, unevaluatedItems: { type: "string", format: "uuid" } }), "unevaluatedItems"],
    ["a keyword inside a branch of anyOf", json({ anyOf: [{ type: "object", properties: {}, propertyNames: { format: "uuid" }, additionalProperties: false }] }), "propertyNames"],
  ])("fails an operation whose request body uses a keyword the walk does not follow: %s", async (_name, requestBody, keyword) => {
    let calls = 0;
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "keyed", method: "post", path: "/api/v1/keyed", auth: "member", requestBody }]),
      fixture: memoryFixture(),
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 200 });
      },
    });
    expect(calls).toBe(0);
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unwalkable_input"]);
    expect(report.failures[0]?.detail).toContain(keyword);
    expect(report.failures[0]?.detail).toContain("does not follow");
  });

  it("fails a query parameter that uses a keyword the walk does not follow", () => {
    const [operation] = classifyOperations(
      documentOf([
        {
          operationId: "filtered",
          path: "/api/v1/filtered",
          auth: "member",
          parameters: [{ name: "filter", in: "query", schema: { type: "string", not: { enum: [""] } } }],
        },
      ]),
    ).operations;
    expect(operation?.unwalkable).toHaveLength(1);
    expect(operation?.unwalkable[0]).toContain('"not"');
  });

  // Zod 4 writes the checks added to a registered schema beside its $ref.
  const NAME_COMPONENTS = { schemas: { Name: { type: "string" }, Tree: { type: "object", properties: { child: { $ref: "#/components/schemas/Tree" } }, additionalProperties: false } } };

  const classifyBody = (schema: unknown) =>
    classifyOperations(
      documentOf([{ operationId: "beside", method: "post", path: "/api/v1/beside", auth: "member", requestBody: json(schema) }], NAME_COMPONENTS),
    ).operations[0];

  it("walks the keywords that sit beside a $ref", () => {
    const operation = classifyBody({
      type: "object",
      properties: { target: { $ref: "#/components/schemas/Name", format: "uuid", pattern: "^.+$" }, label: { $ref: "#/components/schemas/Name", description: "d" } },
      additionalProperties: false,
    });
    expect(operation?.unwalkable).toEqual([]);
    expect(operation?.inputs.map((input) => input.name)).toEqual(["target"]);
  });

  it("walks a $ref with a property beside it, and reports an identifier named only there once", () => {
    const operation = classifyBody({
      $ref: "#/components/schemas/Name",
      type: "object",
      properties: { teamId: { type: "string" } },
      additionalProperties: false,
    });
    expect(operation?.unwalkable).toEqual([]);
    expect(operation?.inputs.map((input) => input.name)).toEqual(["teamId"]);
    expect(classifyBody({ $ref: "#/components/schemas/Name", type: "string", format: "uuid" })?.inputs).toHaveLength(1);
  });

  it.each([
    ["an unknown keyword beside it", { $ref: "#/components/schemas/Name", propertyNames: { format: "uuid" } }, "propertyNames"],
    ["an alternative reference form", { $ref: "#/components/schemas/Name", $dynamicRef: "#node" }, "$dynamicRef"],
    ["an anchor", { $ref: "#/components/schemas/Name", $anchor: "node" }, "$anchor"],
    ["a keyword inside a property", { type: "object", properties: { a: { $ref: "#/components/schemas/Name", not: { format: "uuid" } } }, additionalProperties: false }, '"not"'],
    ["a reference that is not a string", { $ref: 5 }, "$ref is not a string"],
  ])("reports unwalkable input in a $ref schema: %s", (_name, schema, reason) => {
    const operation = classifyBody(schema);
    expect(operation?.unwalkable).toHaveLength(1);
    expect(operation?.unwalkable[0]).toContain(reason);
  });

  it("fails the matrix, with no call sent, for an unknown keyword beside a $ref", async () => {
    let calls = 0;
    const report = await runApiMatrix({
      document: documentOf(
        [{ operationId: "beside", method: "post", path: "/api/v1/beside", auth: "member", requestBody: json({ $ref: "#/components/schemas/Name", propertyNames: { format: "uuid" } }) }],
        NAME_COMPONENTS,
      ),
      fixture: memoryFixture(),
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 200 });
      },
    });
    expect(calls).toBe(0);
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unwalkable_input"]);
  });

  it("reports the identifier of a $ref with format uuid beside it as an unmapped parameter", async () => {
    const calls: ApiCall[] = [];
    const report = await runApiMatrix({
      document: documentOf(
        [
          {
            operationId: "beside",
            method: "post",
            path: "/api/v1/beside",
            auth: "member",
            requestBody: json({ type: "object", properties: { target: { $ref: "#/components/schemas/Name", format: "uuid" } }, additionalProperties: false }),
          },
        ],
        NAME_COMPONENTS,
      ),
      fixture: memoryFixture(),
      request: (call) => {
        calls.push(call);
        return Promise.resolve({ status: 200 });
      },
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unmapped_parameter"]);
    expect(calls).toHaveLength(0);
  });

  it("does not loop on a recursive $ref with siblings", () => {
    const operation = classifyBody({ $ref: "#/components/schemas/Tree", description: "d", nullable: true, type: "object" });
    expect(operation?.unwalkable).toEqual([]);
  });

  // A $ref to a component already on the path adds no target to walk, but the
  // keywords beside that $ref are still part of the schema.
  const TREE = "#/components/schemas/Tree";
  const BASE_COMPONENTS = {
    schemas: {
      ...NAME_COMPONENTS.schemas,
      Base: { type: "object", properties: { ownerId: { type: "string" } }, additionalProperties: false },
      Chain: { type: "object", properties: { next: { $ref: "#/components/schemas/Chain" } }, additionalProperties: false },
    },
  };
  const classifyWith = (components: { readonly schemas: Record<string, unknown> }, schema: unknown) =>
    classifyOperations(
      documentOf([{ operationId: "beside", method: "post", path: "/api/v1/beside", auth: "member", requestBody: json(schema) }], components),
    ).operations[0];

  it("reports an unknown keyword beside a $ref that closes a cycle", () => {
    const tree = { type: "object", properties: { child: { $ref: TREE, propertyNames: { format: "uuid" } } }, additionalProperties: false };
    const operation = classifyWith({ schemas: { Tree: tree } }, { $ref: TREE });
    expect(operation?.unwalkable).toHaveLength(1);
    expect(operation?.unwalkable[0]).toContain("propertyNames");
    expect(operation?.unwalkable[0]).toContain("child");
  });

  it("collects a property beside a $ref that closes a cycle", () => {
    const tree = { type: "object", properties: { child: { $ref: TREE, properties: { target: { type: "string", format: "uuid" } } } }, additionalProperties: false };
    const operation = classifyWith({ schemas: { Tree: tree } }, { $ref: TREE });
    expect(operation?.unwalkable).toEqual([]);
    expect(operation?.inputs.map((input) => input.name)).toEqual(["child.target"]);
  });

  it("walks a $ref to a component again inside the keywords beside a $ref to it", async () => {
    const schema = { $ref: "#/components/schemas/Base", properties: { other: { $ref: "#/components/schemas/Base" } } };
    const operation = classifyWith(BASE_COMPONENTS, schema);
    expect(operation?.unwalkable).toEqual([]);
    expect(operation?.inputs.map((input) => input.name).sort()).toEqual(["other.ownerId", "ownerId"]);

    const calls: ApiCall[] = [];
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "beside", method: "post", path: "/api/v1/beside", auth: "member", requestBody: json(schema) }], BASE_COMPONENTS),
      fixture: memoryFixture(),
      mapping: { ownerId: "member", "other.ownerId": "member" },
      request: (call) => {
        calls.push(call);
        return Promise.resolve(notFound(call));
      },
    });
    expect(report.failures).toEqual([]);
    expect(calls.some((call) => JSON.stringify(call.body).includes('"other":{"ownerId"'))).toBe(true);
  });

  it("terminates on a schema that refers to itself, with and without siblings", () => {
    expect(classifyWith(BASE_COMPONENTS, { $ref: "#/components/schemas/Chain" })?.unwalkable).toEqual([]);
    const nested = { $ref: TREE, properties: { again: { $ref: TREE, properties: { deeper: { $ref: TREE, description: "d" } } } } };
    const operation = classifyWith(BASE_COMPONENTS, nested);
    expect(operation?.unwalkable).toEqual([]);
  });

  it("ignores annotations, validation keywords and extensions, which change no input", () => {
    const [operation] = classifyOperations(
      documentOf([
        {
          operationId: "annotated",
          method: "post",
          path: "/api/v1/annotated",
          auth: "member",
          requestBody: json({
            type: "object",
            title: "Annotated",
            description: "d",
            additionalProperties: false,
            required: ["accountId"],
            "x-internal": true,
            properties: {
              accountId: { type: "string", format: "uuid", description: "d", examples: ["e"], minLength: 36, maxLength: 36, pattern: "^.+$", default: "x" },
              count: { type: "integer", minimum: 0, maximum: 5, exclusiveMinimum: 0, multipleOf: 1, deprecated: true, readOnly: true },
              tags: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 4, uniqueItems: true },
            },
          }),
        },
      ]),
    ).operations;
    expect(operation?.unwalkable).toEqual([]);
    expect(operation?.inputs.map((input) => input.name)).toEqual(["accountId"]);
  });

  it("fails a query parameter that has no schema", async () => {
    const report = await runApiMatrix({
      document: documentOf([{ operationId: "bare", path: "/api/v1/bare", auth: "member", parameters: [{ name: "filter", in: "query" }] }]),
      fixture: memoryFixture(),
      request: () => Promise.resolve({ status: 404 }),
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unwalkable_input"]);
  });

  it("does not look into the body of an operation that is not tenant-scoped", async () => {
    const report = await runApiMatrix({
      document: documentOf([
        { operationId: "signIn", method: "post", path: "/api/v1/sign-in", auth: "anonymous", requestBody: json({ type: "object" }) },
      ]),
      fixture: memoryFixture(),
      request: () => Promise.resolve({ status: 200 }),
    });
    expect(report.failures).toEqual([]);
  });
});
