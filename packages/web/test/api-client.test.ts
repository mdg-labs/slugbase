import { describe, expect, it, vi } from "vitest";
import { ApiProblemError, createApiClient } from "../src/api/client.ts";
import { CONFIG_BODY, json, problem } from "./support.tsx";

function transport(response: () => Response) {
  return vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(response()));
}

describe("the API client", () => {
  it("calls the same origin with the session cookie and returns the typed body", async () => {
    const fetch = transport(() => json(CONFIG_BODY));
    const { data } = await createApiClient({ fetch }).GET("/api/config");
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toBe(`${globalThis.location.origin}/api/config`);
    expect(request?.credentials).toBe("same-origin");
    expect(data?.product.name).toBe(CONFIG_BODY.product.name);
  });

  it("turns a problem document into an ApiProblemError with its code, status and request id", async () => {
    const api = createApiClient({ fetch: transport(() => problem(503, "unavailable", "req-1", "db down for <user>")) });
    const error = await api.GET("/api/config").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiProblemError);
    expect(error).toMatchObject({ code: "unavailable", status: 503, requestId: "req-1" });
    expect((error as Error).message).not.toContain("db down");
  });

  it("leaves a failure that is not a problem document to the caller as an error body", async () => {
    const api = createApiClient({ fetch: transport(() => new Response("bad gateway", { status: 502 })) });
    const result = await api.GET("/api/config");
    expect(result.response.status).toBe(502);
    expect(result.error).toBe("bad gateway");
  });

  it("leaves a problem content type with a body that is no problem to the caller", async () => {
    const api = createApiClient({
      fetch: transport(() => json({ unrelated: true }, { status: 500, contentType: "application/problem+json" })),
    });
    const result = await api.GET("/api/config");
    expect(result.error).toEqual({ unrelated: true });
  });

  it("rejects with the transport's error when the network fails", async () => {
    const api = createApiClient({ fetch: () => Promise.reject(new TypeError("network down")) });
    await expect(api.GET("/api/config")).rejects.toThrow("network down");
  });
});
