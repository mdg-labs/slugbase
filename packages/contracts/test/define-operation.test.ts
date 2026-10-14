import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  AUTH_POLICIES,
  defineOperation,
  emptyResponse,
  jsonResponse,
  problemResponse,
  rateLimitedResponse,
  type OperationDefinition,
} from "../src/operations/define.ts";
import { omit } from "./omit.ts";

const Pong = z.strictObject({ ok: z.boolean() });

const complete = {
  method: "get",
  path: "/api/v1/pong",
  operationId: "getPong",
  tag: "pong",
  auth: "member",
  rate: "read",
  responses: { 200: jsonResponse("ok", Pong), 404: problemResponse("missing") },
} satisfies OperationDefinition;

describe("rateLimitedResponse", () => {
  it("builds a problem response that declares Retry-After in integer seconds", () => {
    const limited = rateLimitedResponse("slow down");
    expect(limited.kind).toBe("problem");
    expect(limited.headers["Retry-After"].schema.safeParse(30).success).toBe(true);
    expect(limited.headers["Retry-After"].schema.safeParse(1.5).success).toBe(false);
    expect(limited.headers["Retry-After"].schema.safeParse(0).success).toBe(false);
  });

  it("is the only 429 an operation accepts at compile time", () => {
    expect(defineOperation({ ...complete, responses: { 200: jsonResponse("ok", Pong), 429: rateLimitedResponse("slow down") } }).responses[429].kind).toBe("problem");
    // @ts-expect-error #447 a 429 declares Retry-After, so it is built with rateLimitedResponse
    defineOperation({ ...complete, responses: { 200: jsonResponse("ok", Pong), 429: problemResponse("slow down") } });
  });
});

describe("defineOperation types", () => {
  it("accepts a declaration with its whole policy and returns it unchanged", () => {
    expect(defineOperation(complete)).toBe(complete);
  });

  it("keeps the literal declaration, so a handler is typed from the operation's schemas", () => {
    const declared = defineOperation({ ...complete, operationId: "getPong", auth: "member", responses: { 200: jsonResponse("ok", Pong), 404: problemResponse("missing") } });
    expectTypeOf(declared.operationId).toEqualTypeOf<"getPong">();
    expectTypeOf(declared.auth).toEqualTypeOf<"member">();
    expectTypeOf(declared.responses[200].schema).toEqualTypeOf(Pong);
  });

  it("accepts the optional scope, entitlement and audience", () => {
    expect(
      defineOperation({ ...complete, scope: "read", entitlement: "sharing.teams", audience: "machine" }).scope,
    ).toBe("read");
  });

  it("accepts the partial auth policy and a declared re-authentication, and keeps both literal", () => {
    const declared = defineOperation({ ...complete, auth: "partial", reauth: false });
    expectTypeOf(declared.auth).toEqualTypeOf<"partial">();
    expect(defineOperation({ ...complete, reauth: true }).reauth).toBe(true);
    expect(AUTH_POLICIES).toContain("partial");
  });

  it("rejects a re-authentication that is not a boolean at compile time", () => {
    // @ts-expect-error #437 reauth is a boolean
    defineOperation({ ...complete, reauth: "yes" });
  });

  it("rejects an operation without auth at compile time", () => {
    const rest = omit(complete, "auth");
    // @ts-expect-error #17 auth (x-slugbase-auth) is required
    defineOperation(rest);
  });

  it("rejects an operation without a rate bucket at compile time", () => {
    const rest = omit(complete, "rate");
    // @ts-expect-error #17 rate (x-slugbase-rate) is required
    defineOperation(rest);
  });

  it("rejects an operation without operationId, tag or responses at compile time", () => {
    const noId = omit(complete, "operationId");
    const noTag = omit(complete, "tag");
    const noResponses = omit(complete, "responses");
    // @ts-expect-error #17 operationId is required
    defineOperation(noId);
    // @ts-expect-error #17 tag is required
    defineOperation(noTag);
    // @ts-expect-error #17 responses are required
    defineOperation(noResponses);
  });

  it("rejects values outside the policy vocabularies at compile time", () => {
    // @ts-expect-error #17 auth is one of the seven policies
    defineOperation({ ...complete, auth: "everyone" });
    // @ts-expect-error #17 rate is a bucket of doc 04 section 7 or none
    defineOperation({ ...complete, rate: "fast" });
    // @ts-expect-error #17 scope is read or write
    defineOperation({ ...complete, scope: "admin" });
  });

  it("rejects an operation without a 4xx problem response at compile time", () => {
    // @ts-expect-error #17 at least one 4xx problem response is required
    defineOperation({ ...complete, responses: { 200: jsonResponse("ok", Pong) } });
    // @ts-expect-error #17 a 4xx response must be a problem response
    defineOperation({ ...complete, responses: { 200: jsonResponse("ok", Pong), 404: emptyResponse("gone") } });
  });
});
