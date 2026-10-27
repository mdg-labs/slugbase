import { describe, expect, it, vi } from "vitest";
import { ApiProblemError, createApiClient } from "../src/api/client.ts";
import { CONFIG_BODY, json, problem } from "./support.tsx";

function transport(response: () => Response) {
  return vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(response()));
}

describe("the API client", () => {
  it("calls the same origin with the session cookie and returns the typed body", async () => {
    const send = transport(() => json(CONFIG_BODY));
    const { data } = await createApiClient({ fetch: send }).GET("/api/config");
    const request = send.mock.calls[0]?.[0];
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

  describe("a mutation without a body", () => {
    const sentRequest = async (call: (api: ReturnType<typeof createApiClient>) => Promise<unknown>): Promise<Request> => {
      const send = transport(() => new Response(null, { status: 204 }));
      await call(createApiClient({ fetch: send }));
      const request = send.mock.calls[0]?.[0];
      if (request === undefined) {
        throw new Error("nothing was sent");
      }
      return request;
    };

    it("declares application/json, which the cross-site rule of the server requires", async () => {
      const request = await sentRequest((api) => api.POST("/api/v1/auth/logout"));

      expect(request.method).toBe("POST");
      expect(request.headers.get("Content-Type")).toBe("application/json");
    });

    it("declares it for a DELETE too, without a header of its own at the call", async () => {
      const request = await sentRequest((api) => api.DELETE("/api/v1/me/sessions"));

      expect(request.method).toBe("DELETE");
      expect(request.headers.get("Content-Type")).toBe("application/json");
    });

    it("declares it where the engine gives an empty request a body stream, as Firefox does", async () => {
      const PlatformRequest = globalThis.Request;
      class StreamBodyRequest extends PlatformRequest {
        override get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
          return new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
              controller.close();
            },
          });
        }
      }
      vi.stubGlobal("Request", StreamBodyRequest);
      try {
        const request = await sentRequest((api) => api.DELETE("/api/v1/me/sessions"));

        expect(request.headers.get("Content-Type")).toBe("application/json");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps the type a call set itself", async () => {
      const request = await sentRequest((api) =>
        api.POST("/api/v1/auth/logout", { headers: { "Content-Type": "application/json; charset=utf-8" } }),
      );

      expect(request.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    });

    it("leaves a read without a type", async () => {
      const request = await sentRequest((api) => api.GET("/api/config"));

      expect(request.headers.has("Content-Type")).toBe(false);
    });

    it("leaves the type of a request with a body to its serializer", async () => {
      const request = await sentRequest((api) =>
        api.POST("/api/v1/me/password", { body: { currentPassword: "old", newPassword: "new" } }),
      );

      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(await request.json()).toEqual({ currentPassword: "old", newPassword: "new" });
    });
  });

  describe("onUnauthenticated", () => {
    function clientAnswering(response: Response, path: "/api/config" | "/version") {
      const onUnauthenticated = vi.fn<() => void>();
      const api = createApiClient({ fetch: transport(() => response), onUnauthenticated });
      const call = path === "/api/config" ? api.GET("/api/config") : api.GET("/version");
      return { onUnauthenticated, call };
    }

    it("is called, and the error still thrown, for a 401 from any call but /api/config", async () => {
      const { onUnauthenticated, call } = clientAnswering(problem(401, "unauthenticated", "req-1"), "/version");
      await expect(call).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    });

    it("is called for a 401 that is no problem document", async () => {
      const { onUnauthenticated, call } = clientAnswering(new Response("unauthorized", { status: 401 }), "/version");
      await call;
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    });

    it("is not called for a 401 from /api/config", async () => {
      const { onUnauthenticated, call } = clientAnswering(problem(401, "unauthenticated", "req-1"), "/api/config");
      await expect(call).rejects.toBeInstanceOf(ApiProblemError);
      expect(onUnauthenticated).not.toHaveBeenCalled();
    });

    it("is not called for a request to re-authenticate on a live session", async () => {
      const { onUnauthenticated, call } = clientAnswering(problem(401, "reauth_required", "req-1"), "/version");
      await expect(call).rejects.toMatchObject({ code: "reauth_required" });
      expect(onUnauthenticated).not.toHaveBeenCalled();
    });

    it("is not called for another failure or a success", async () => {
      const failed = clientAnswering(problem(403, "forbidden", "req-1"), "/version");
      await expect(failed.call).rejects.toBeInstanceOf(ApiProblemError);
      const ok = clientAnswering(json({ version: "1" }), "/version");
      await ok.call;
      expect(failed.onUnauthenticated).not.toHaveBeenCalled();
      expect(ok.onUnauthenticated).not.toHaveBeenCalled();
    });
  });
});
