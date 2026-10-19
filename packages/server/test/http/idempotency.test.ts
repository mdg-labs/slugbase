import { defineOperation, emptyResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import type { Database } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChainContext, MatchedRoute, RequestStage, ValidatedInput } from "../../src/http/chain.ts";
import { createIdempotency, requestHash } from "../../src/http/idempotency.ts";
import { ProblemError } from "../../src/http/problem.ts";

// The parts of stage 9a that need no database: which requests it looks at, how it reads the header, and what a
// request hashes to. The claim, the replay and the conflict run against the database in
// test/routes/invitations-idempotency.integration.test.ts.

const keyed = defineOperation({
  method: "post",
  path: "/api/v1/notes",
  operationId: "createNote",
  tag: "notes",
  auth: "member",
  rate: "write",
  idempotency: true,
  request: { body: z.strictObject({ title: z.string() }) },
  responses: { 204: emptyResponse("done"), 409: problemResponse("conflict") },
});
const plain: OperationDefinition = { ...keyed, operationId: "createPlainNote", idempotency: false };

function fake(operation: OperationDefinition, header: string | undefined, input: ValidatedInput = {}, workspaceId: string | null = "ws-1"): Parameters<RequestStage>[0] & ChainContext {
  const route = { operation, handler: () => new Response(), params: {} } satisfies MatchedRoute;
  const values: Record<string, unknown> = { route, input, workspaceId: workspaceId ?? undefined };
  return {
    req: { header: (name: string) => (name.toLowerCase() === "idempotency-key" ? header : undefined) },
    get: (name: string) => values[name],
  } as unknown as Parameters<RequestStage>[0] & ChainContext;
}

const withTenant: Database["withTenant"] = () => {
  throw new Error("a request that is not keyed opens no transaction of its own");
};

async function run(operation: OperationDefinition, header: string | undefined): Promise<{ next: number; error: unknown }> {
  const stage = createIdempotency({ withTenant });
  let calls = 0;
  try {
    await stage(fake(operation, header), () => {
      calls += 1;
      return Promise.resolve();
    });
  } catch (error) {
    return { next: calls, error };
  }
  return { next: calls, error: undefined };
}

describe("the idempotency stage", () => {
  it("passes a request without the header, and every request of an operation that declares no idempotency, to the handler untouched", async () => {
    expect(await run(keyed, undefined)).toEqual({ next: 1, error: undefined });
    expect(await run(plain, "0192f3a0-aaaa-7000-8000-000000000001")).toEqual({ next: 1, error: undefined });
    expect(await run(plain, "not a key")).toEqual({ next: 1, error: undefined });
  });

  it("refuses a key that is not a single UUID with 400 bad_request, before the handler", async () => {
    for (const header of ["", " ", "not-a-uuid", "0192f3a0-aaaa-7000-8000-00000000000", "0192f3a0-aaaa-7000-8000-000000000001, 0192f3a0-aaaa-7000-8000-000000000002"]) {
      const outcome = await run(keyed, header);
      expect(outcome.next).toBe(0);
      expect(outcome.error).toBeInstanceOf(ProblemError);
      expect(outcome.error).toMatchObject({ code: "bad_request" });
    }
  });

  it("fails closed for a keyed request that has no principal", async () => {
    const outcome = await run(keyed, "0192f3a0-aaaa-7000-8000-000000000001");

    expect(outcome.next).toBe(0);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(ProblemError);
  });
});

describe("the hash of a request", () => {
  const hash = (operation: OperationDefinition, input: ValidatedInput, workspaceId?: string | null): string =>
    requestHash(fake(operation, undefined, input, workspaceId), operation.operationId).toString("hex");

  it("is 32 bytes and the same for the same request however the members of the body are ordered", () => {
    expect(requestHash(fake(keyed, undefined, { body: { a: 1, b: { c: [1, { d: 2, e: 3 }] } } }), "createNote")).toHaveLength(32);
    expect(hash(keyed, { body: { a: 1, b: { c: [1, { d: 2, e: 3 }] } } })).toBe(hash(keyed, { body: { b: { c: [1, { e: 3, d: 2 }] }, a: 1 } }));
  });

  it("differs for another body, another list order, another query, another path, another operation and another workspace", () => {
    const base = { params: { id: "1" }, query: { q: "x" }, body: { title: "a", tags: ["x", "y"] } };
    const hashes = new Set([
      hash(keyed, base),
      hash(keyed, { ...base, body: { title: "b", tags: ["x", "y"] } }),
      hash(keyed, { ...base, body: { title: "a", tags: ["y", "x"] } }),
      hash(keyed, { ...base, query: { q: "y" } }),
      hash(keyed, { ...base, params: { id: "2" } }),
      hash(plain, base),
      hash(keyed, base, "ws-2"),
      hash(keyed, base, null),
    ]);

    expect(hashes.size).toBe(8);
  });

  it("tells a field that is absent from one that is null", () => {
    expect(hash(keyed, { body: { a: null } })).not.toBe(hash(keyed, { body: {} }));
  });
});
