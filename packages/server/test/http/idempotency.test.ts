import { defineOperation, emptyResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import type { Database } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChainContext, MatchedRoute, RequestStage, ValidatedInput } from "../../src/http/chain.ts";
import { createIdempotency, requestHash, uploadDigest } from "../../src/http/idempotency.ts";
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

describe("the hash of an upload", () => {
  const form = (content: string, extra: Record<string, string> = {}, filename = "bookmarks.html"): FormData => {
    const data = new FormData();
    data.set("file", new File([content], filename, { type: "text/html" }));
    for (const [name, value] of Object.entries(extra)) {
      data.set(name, value);
    }
    return data;
  };
  const digest = async (data: FormData): Promise<string> => {
    // Serialised by two encoders, each of which picks its own boundary.
    const response = new Response(data);
    return uploadDigest(new Request("http://localhost/", { method: "POST", headers: { "content-type": response.headers.get("content-type") ?? "" }, body: new Uint8Array(await response.arrayBuffer()) }));
  };

  it("is the same for the same file whatever the boundary, the filename and the media type of the request, and differs for another file, even of the same size", async () => {
    const first = await digest(form("<DL><DT><A HREF=\"https://e.test/a\">a</A></DL>"));

    expect(await digest(form("<DL><DT><A HREF=\"https://e.test/a\">a</A></DL>"))).toBe(first);
    expect(await digest(form("<DL><DT><A HREF=\"https://e.test/a\">a</A></DL>", {}, "renamed.htm"))).toBe(first);
    expect(await digest(form("<DL><DT><A HREF=\"https://e.test/b\">a</A></DL>"))).not.toBe(first);
    expect(await digest(form(""))).not.toBe(first);
  });

  it("covers every part, the name of each, and whether it is text or a file, and is no mistake for where one part ends and the next begins", async () => {
    const base = await digest(form("x"));
    const hashes = new Set([base, await digest(form("x", { other: "1" })), await digest(form("x", { other: "2" })), await digest(form("xother", {})), await digest(form("x", { other: "" }))]);
    const asText = new FormData();
    asText.set("file", "x");

    expect(hashes.size).toBe(5);
    expect(await digest(asText)).not.toBe(base);
  });

  it("digests a body that is not multipart as the bytes it is, so that the same key for another body is another request", async () => {
    const send = (body: string) => uploadDigest(new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body }));

    expect(await send("[]")).toBe(await send("[]"));
    expect(await send("[]")).not.toBe(await send("[ ]"));
    expect(await send("[]")).toMatch(/^bytes:/);
  });

  it("is added to the hash of the request only when there is one, so that no other request changes its hash", () => {
    const base = requestHash(fake(keyed, undefined, { body: { title: "a" } }), "createNote");
    const withUpload = (digest: string) => requestHash(fake(keyed, undefined, { body: { title: "a" } }), "createNote", digest);

    expect(requestHash(fake(keyed, undefined, { body: { title: "a" } }), "createNote", undefined).equals(base)).toBe(true);
    expect(withUpload("parts:1").equals(base)).toBe(false);
    expect(withUpload("parts:1").equals(withUpload("parts:2"))).toBe(false);
    expect(withUpload("parts:1").equals(withUpload("parts:1"))).toBe(true);
  });
});
