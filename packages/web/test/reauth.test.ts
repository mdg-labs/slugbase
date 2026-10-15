import { describe, expect, it, vi } from "vitest";
import { ApiProblemError, createApiClient } from "../src/api/client.ts";
import { createReauth, isReauthCancelled, reauthMiddleware } from "../src/auth/reauth.ts";
import { json, problem } from "./support.tsx";

// The retry rule of doc 04 section 4.4: a 401 reauth_required opens the prompt, and the same request is
// sent again once, after the member confirmed.

type Transport = (request: Request) => Promise<Response>;

function apiWith(reauth: ReturnType<typeof createReauth>, transport: Transport) {
  const api = createApiClient({ baseUrl: "http://localhost:3000", fetch: transport });
  api.use(reauthMiddleware(reauth));
  return api;
}

const BODY = { currentPassword: "old", newPassword: "new" };

describe("reauthMiddleware", () => {
  it("sends the same request again, with its body, after the prompt is confirmed", async () => {
    const reauth = createReauth();
    const seen: string[] = [];
    const transport = vi.fn<Transport>(async (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
      return seen.length === 1 ? problem(401, "reauth_required", "req-1") : new Response(null, { status: 204 });
    });
    const api = apiWith(reauth, transport);

    const result = api.POST("/api/v1/me/password", { body: BODY });
    await vi.waitFor(() => {
      expect(reauth.isOpen()).toBe(true);
    });
    expect(seen).toHaveLength(1);
    reauth.settle(true);

    expect((await result).response.status).toBe(204);
    expect(seen).toEqual([`POST /api/v1/me/password ${JSON.stringify(BODY)}`, `POST /api/v1/me/password ${JSON.stringify(BODY)}`]);
    expect(reauth.isOpen()).toBe(false);
  });

  it("sends it again only once: a second reauth_required is the answer", async () => {
    const reauth = createReauth();
    const transport = vi.fn<Transport>(() => Promise.resolve(problem(401, "reauth_required", "req-1")));
    const api = apiWith(reauth, transport);

    const result = api.POST("/api/v1/me/password", { body: BODY });
    await vi.waitFor(() => {
      expect(reauth.isOpen()).toBe(true);
    });
    reauth.settle(true);

    await expect(result).rejects.toMatchObject({ status: 401, code: "reauth_required" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(reauth.isOpen()).toBe(false);
  });

  it("does not send it again, and fails as cancelled, when the member gives up", async () => {
    const reauth = createReauth();
    const transport = vi.fn<Transport>(() => Promise.resolve(problem(401, "reauth_required", "req-1")));
    const api = apiWith(reauth, transport);

    const result = api.POST("/api/v1/me/password", { body: BODY });
    await vi.waitFor(() => {
      expect(reauth.isOpen()).toBe(true);
    });
    reauth.settle(false);

    const error: unknown = await result.catch((caught: unknown) => caught);
    expect(isReauthCancelled(error)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("opens one prompt for requests that ask while it is open and sends each of them again", async () => {
    const reauth = createReauth();
    const opened = vi.fn();
    reauth.subscribe(() => {
      if (reauth.isOpen()) {
        opened();
      }
    });
    const attempts = new Map<string, number>();
    const transport = vi.fn<Transport>((request) => {
      const path = new URL(request.url).pathname;
      attempts.set(path, (attempts.get(path) ?? 0) + 1);
      return Promise.resolve(attempts.get(path) === 1 ? problem(401, "reauth_required", "req-1") : new Response(null, { status: 204 }));
    });
    const api = apiWith(reauth, transport);

    const first = api.POST("/api/v1/me/password", { body: BODY });
    const second = api.DELETE("/api/v1/me/sessions", { headers: { "Content-Type": "application/json" } });
    await vi.waitFor(() => {
      expect(attempts.size).toBe(2);
    });
    reauth.settle(true);

    expect((await first).response.status).toBe(204);
    expect((await second).response.status).toBe(204);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("never opens the prompt for the re-authentication call itself: its reauth_required is a wrong password", async () => {
    const reauth = createReauth();
    const transport = vi.fn<Transport>(() => Promise.resolve(problem(401, "reauth_required", "req-1")));
    const api = apiWith(reauth, transport);

    await expect(api.POST("/api/v1/me/reauth", { body: { password: "nope" } })).rejects.toBeInstanceOf(ApiProblemError);

    expect(reauth.isOpen()).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("leaves every other answer alone", async () => {
    const reauth = createReauth();
    const transport = vi.fn<Transport>(() => Promise.resolve(problem(401, "unauthenticated", "req-1")));
    const api = apiWith(reauth, transport);

    await expect(api.POST("/api/v1/me/password", { body: BODY })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(reauth.isOpen()).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);

    transport.mockResolvedValueOnce(json({ ok: true }, { status: 200 }));
    expect((await api.POST("/api/v1/me/password", { body: BODY })).response.status).toBe(200);
  });
});
