import { describe, expect, it } from "vitest";
import { classifyOperations, runApiMatrix, runTokenMatrix, type ApiCall, type ApiResponse, type TokenCall } from "../src/tenancy.ts";
import { documentOf, memoryFixture } from "./support/memory-fixture.ts";

// Token mode of the matrix and the token principals of the API mode, against
// stub request functions (doc 08 section 3.3, doc 10 T3 and T18): what each stub
// does is the failure the matrix has to see.

const problem = (status: number, code: string): ApiResponse => ({ status, body: { status, code } });
const forbidden = problem(403, "forbidden");
const scopeRefused = problem(403, "token_scope");

const DOCUMENT = documentOf([
  { operationId: "getMe", path: "/api/v1/me", auth: "account", scope: "read" },
  { operationId: "createThing", path: "/api/v1/things", auth: "member", method: "post", scope: "write" },
  { operationId: "listSessions", path: "/api/v1/me/sessions", auth: "account" },
  { operationId: "changePassword", path: "/api/v1/me/password", auth: "account", method: "post" },
  { operationId: "createToken", path: "/api/v1/me/api-tokens", auth: "account", method: "post", scope: "write", reauth: true },
  { operationId: "getHealth", path: "/health", auth: "anonymous" },
]);

/** The chain as built: a token never calls what declares no scope or reauth, a read token no write, the anonymous answer is the same. */
function chain(call: TokenCall): Promise<ApiResponse> {
  const { operation, scope } = call;
  if (operation.policy === "anonymous" || scope === undefined) {
    return Promise.resolve(operation.policy === "anonymous" ? { status: 200 } : problem(401, "unauthenticated"));
  }
  if (operation.scope === undefined || operation.reauth) {
    return Promise.resolve(forbidden);
  }
  return Promise.resolve(operation.scope === "write" && scope === "read" ? scopeRefused : { status: 200 });
}

describe("token mode", () => {
  it("passes for the chain as built and sorts every operation by what the document declares", async () => {
    const report = await runTokenMatrix({ document: DOCUMENT, request: chain });
    expect(report.failures).toEqual([]);
    expect(report).toMatchObject({ refused: 3, scoped: 1, readable: 1, unaffected: 1 });
    // an anonymous operation is asked three times (no token and each scope), every other one twice
    expect(report.attempts).toBe(3 + 5 * 2);
  });

  it("covers an operation added to the document with no other edit", async () => {
    const seen: string[] = [];
    const document = documentOf([
      { operationId: "getMe", path: "/api/v1/me", auth: "account", scope: "read" },
      { operationId: "newThing", path: "/api/v1/new-things/{id}", auth: "admin", method: "delete" },
    ]);
    const report = await runTokenMatrix({
      document,
      request: (call) => {
        seen.push(`${call.operation.operationId} ${call.scope ?? "none"}`);
        return chain(call);
      },
    });
    expect(report.failures).toEqual([]);
    expect(seen).toContain("newThing read");
    expect(seen).toContain("newThing read-write");
    expect(report.refused).toBe(1);
  });

  it("fails an operation that is missing its auth declaration", async () => {
    const document = documentOf([
      { operationId: "getMe", path: "/api/v1/me", auth: "account", scope: "read" },
      { operationId: "undeclared", path: "/api/v1/undeclared", auth: undefined },
    ]);
    const report = await runTokenMatrix({ document, request: chain });
    expect(report.failures.map((failure) => [failure.kind, failure.subject])).toEqual([["unclassified_operation", expect.stringContaining("undeclared") as string]]);
  });

  it("fails an operation that declares no scope but lets a token through, for either scope", async () => {
    const report = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "listSessions" && call.scope !== undefined ? Promise.resolve({ status: 200 }) : chain(call)),
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["token_not_refused", "token_not_refused"]);
    expect(report.failures[0]?.detail).toContain("no scope");
  });

  it("fails an operation that declares reauth but lets a token through", async () => {
    const report = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "createToken" && call.scope === "read-write" ? Promise.resolve({ status: 201 }) : chain(call)),
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["token_not_refused"]);
    expect(report.failures[0]?.detail).toContain("reauth");
  });

  it("fails a refusal that is not 403 forbidden, such as a validation error that came first", async () => {
    const report = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "changePassword" && call.scope !== undefined ? Promise.resolve(problem(422, "validation_failed")) : chain(call)),
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["token_not_refused", "token_not_refused"]);
    expect(report.failures[0]?.detail).toContain("422 validation_failed");
  });

  it("fails a read token that gets through on a write scope, and a token its own scope should admit", async () => {
    const lax = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "createThing" ? Promise.resolve({ status: 200 }) : chain(call)),
    });
    expect(lax.failures.map((failure) => failure.kind)).toEqual(["scope_not_enforced"]);
    const strict = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "createThing" ? Promise.resolve(scopeRefused) : chain(call)),
    });
    expect(strict.failures.map((failure) => failure.kind)).toEqual(["token_refused"]);
    expect(strict.failures[0]?.detail).toContain("read-write");
  });

  it("fails a mutation that declares the read scope", async () => {
    const document = documentOf([{ operationId: "wipe", path: "/api/v1/wipe", auth: "member", method: "delete", scope: "read" }]);
    const report = await runTokenMatrix({ document, request: chain });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["mutation_declared_read"]);
  });

  it("fails an anonymous operation that a token makes answer differently", async () => {
    const report = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "getHealth" && call.scope === "read-write" ? Promise.resolve(forbidden) : chain(call)),
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["token_changed_answer"]);
    expect(report.failures[0]?.detail).toContain("403 forbidden");
  });

  it("reports a request that threw instead of skipping the operation", async () => {
    const report = await runTokenMatrix({
      document: DOCUMENT,
      request: (call) => (call.operation.operationId === "getMe" ? Promise.reject(new Error("no fixture")) : chain(call)),
    });
    expect(new Set(report.failures.map((failure) => failure.kind))).toEqual(new Set(["request_failed"]));
    expect(report.failures[0]?.detail).toContain("no fixture");
  });
});

describe("API mode with token principals", () => {
  const document = (scope?: string, reauth?: boolean, auth = "member"): unknown =>
    documentOf([{ operationId: "getWidget", path: "/api/v1/widgets/{widgetId}", auth, ...(scope === undefined ? {} : { scope }), ...(reauth === undefined ? {} : { reauth }) }]);
  const run = (doc: unknown, request: (call: ApiCall) => Promise<ApiResponse>) =>
    runApiMatrix({ document: doc, fixture: memoryFixture({ withTokens: true }), mapping: { widgetId: "bookmark" }, request });
  const notFound: ApiResponse = { status: 404 };
  const isToken = (call: ApiCall): boolean => call.principal.credentials.startsWith("token:");

  it("sends the read and the read-write token of every role beside the sessions", async () => {
    const seen: string[] = [];
    const report = await run(document("read"), (call) => {
      seen.push(call.principal.credentials.replace(/^session:.*/, "session"));
      return Promise.resolve(notFound);
    });
    expect(report.failures).toEqual([]);
    // three sessions and six tokens against the two bookmarks of B
    expect(report.attempts).toBe(9 * 2);
    expect(new Set(seen)).toEqual(new Set(["session", ...["owner", "admin", "member"].flatMap((role) => [`token:read:${role}`, `token:read-write:${role}`])]));
  });

  it("expects 403 for every token on an operation that declares no scope, and 404 for the sessions", async () => {
    const answer = (call: ApiCall): Promise<ApiResponse> => Promise.resolve(isToken(call) ? forbidden : notFound);
    expect((await run(document(), answer)).failures).toEqual([]);
    const reached = await run(document(), () => Promise.resolve(notFound));
    expect(reached.failures).toHaveLength(12);
    expect(reached.failures[0]?.detail).toContain("by a ");
    expect(reached.failures[0]?.detail).toContain("never calls it");
  });

  it("expects 403 for every token on an operation that declares reauth, even with a scope", async () => {
    const answer = (call: ApiCall): Promise<ApiResponse> => Promise.resolve(isToken(call) ? forbidden : notFound);
    expect((await run(document("read", true), answer)).failures).toEqual([]);
  });

  it("expects 403 for a read token on the write scope, and the role's answer for a read-write one", async () => {
    const answer = (call: ApiCall): Promise<ApiResponse> =>
      Promise.resolve(isToken(call) && call.principal.credentials.startsWith("token:read:") ? forbidden : notFound);
    expect((await run(document("write"), answer)).failures).toEqual([]);
    const reached = await run(document("write"), () => Promise.resolve(notFound));
    expect(reached.failures).toHaveLength(6);
    expect(reached.failures[0]?.detail).toContain("read token");
  });

  it("expects 403 for a token whose role is below the policy, as for a session", async () => {
    const below = (call: ApiCall): boolean => call.principal.role === "member";
    const answer = (call: ApiCall): Promise<ApiResponse> => Promise.resolve(below(call) ? forbidden : notFound);
    expect((await run(document("read", undefined, "admin"), answer)).failures).toEqual([]);
  });

  it("fails a token that finds the row of B where it is not refused first", async () => {
    const leaky = (call: ApiCall): Promise<ApiResponse> => Promise.resolve(isToken(call) ? { status: 200, body: { title: "quarterly-plan-of-b" } } : notFound);
    const report = await run(document("read"), leaky);
    expect(report.failures.filter((failure) => failure.kind === "unexpected_status")).toHaveLength(12);
    expect(report.failures.some((failure) => failure.kind === "leaked_name")).toBe(true);
  });
});

describe("classification of the token rules", () => {
  it("reads the scope and the reauth declaration of each operation", () => {
    const operations = classifyOperations(DOCUMENT).operations;
    expect(operations.map((operation) => [operation.operationId, operation.scope, operation.reauth])).toEqual([
      ["getMe", "read", false],
      ["createThing", "write", false],
      ["listSessions", undefined, false],
      ["changePassword", undefined, false],
      ["createToken", "write", true],
      ["getHealth", undefined, false],
    ]);
  });
});
