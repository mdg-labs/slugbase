import { describe, expect, it } from "vitest";
import { ApiProblemError, createApiClient, parseRetryAfter } from "../src/api/client.ts";

describe("parseRetryAfter", () => {
  it.each([
    ["42", 42],
    [" 7 ", 7],
    ["0", 0],
  ])("reads the delay %j", (header, seconds) => {
    expect(parseRetryAfter(header)).toBe(seconds);
  });

  it("reads an HTTP date as the seconds until it, rounded up and never below zero", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now + 500)).toBe(0);
  });

  it.each([null, "", "  ", "soon", "-5", "1.5"])("is undefined for %j", (header) => {
    expect(parseRetryAfter(header)).toBeUndefined();
  });
});

describe("a problem response", () => {
  function clientAnswering(response: Response) {
    return createApiClient({ baseUrl: "http://localhost", fetch: () => Promise.resolve(response) });
  }

  it("carries the wait of Retry-After and the per-field errors of the document", async () => {
    const body = {
      type: "t",
      title: "validation_failed",
      status: 422,
      code: "validation_failed",
      detail: "d",
      requestId: "req-1",
      errors: [{ path: "email", code: "too_long" }, "not an error", { path: 5 }],
    };
    const client = clientAnswering(
      new Response(JSON.stringify(body), {
        status: 429,
        headers: { "Content-Type": "application/problem+json", "Retry-After": "30" },
      }),
    );

    const error = await client.POST("/api/v1/auth/login", { body: { email: "a", password: "b", remember: false } }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiProblemError);
    expect(error).toMatchObject({ retryAfterSeconds: 30, errors: [{ path: "email", code: "too_long" }] });
  });

  it("has no wait and no field errors when the document and headers name none", async () => {
    const body = { type: "t", title: "unauthenticated", status: 401, code: "unauthenticated", detail: "d", requestId: "req-1" };
    const client = clientAnswering(
      new Response(JSON.stringify(body), { status: 401, headers: { "Content-Type": "application/problem+json" } }),
    );

    const error = await client.POST("/api/v1/auth/login", { body: { email: "a", password: "b", remember: false } }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ retryAfterSeconds: undefined, errors: [] });
  });
});
