import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("client-api-fetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("fetchCsrfHeaders", () => {
    it("fetches same-origin csrf token in browser context", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ csrfToken: "tok-1" }),
      });

      const { fetchCsrfHeaders } = await import("./client-api-fetch.js");
      const headers = await fetchCsrfHeaders();

      expect(headers).toEqual({
        "Content-Type": "application/json",
        "x-csrf-token": "tok-1",
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/auth/csrf-token",
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("uses server API base when request is passed", async () => {
      vi.stubEnv("API_BASE_URL", "https://api.example.com");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ csrfToken: "tok-2" }),
      });

      const { fetchCsrfHeaders } = await import("./client-api-fetch.js");
      const request = {
        headers: new Headers({ Cookie: "session=abc" }),
      } as Request;
      await fetchCsrfHeaders(request);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/csrf-token",
        expect.objectContaining({ credentials: undefined }),
      );
    });
  });

  describe("apiFetch", () => {
    it("uses same-origin path with credentials when no request is passed", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

      const { apiFetch } = await import("./client-api-fetch.js");
      await apiFetch("/workspaces", { method: "GET" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/workspaces",
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("attaches CSRF headers for mutations when csrf is true", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ csrfToken: "csrf-9" }),
        })
        .mockResolvedValueOnce({ ok: true });

      const { apiFetch } = await import("./client-api-fetch.js");
      await apiFetch("/members/user-1", { method: "DELETE", csrf: true });

      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        "/members/user-1",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ "x-csrf-token": "csrf-9" }),
        }),
      );
    });

    it("uses pre-fetched csrfHeaders without fetching a new token", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

      const { apiFetch } = await import("./client-api-fetch.js");
      await apiFetch("/tags/t-1/bookmarks", {
        method: "POST",
        csrfHeaders: {
          "Content-Type": "application/json",
          "x-csrf-token": "shared-token",
        },
        body: JSON.stringify({ bookmarkId: "bm-1" }),
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/tags/t-1/bookmarks",
        expect.objectContaining({
          headers: expect.objectContaining({ "x-csrf-token": "shared-token" }),
        }),
      );
    });
  });

  describe("serverFetchJson", () => {
    it("uses server API base and forwards cookies", async () => {
      vi.stubEnv("API_BASE_URL", "https://api.example.com");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "ws-1" }),
      });

      const { serverFetchJson } = await import("./client-api-fetch.js");
      const request = {
        headers: new Headers({ Cookie: "session=xyz" }),
      } as Request;
      const data = await serverFetchJson<{ id: string }>(request, "/workspaces/active");

      expect(data).toEqual({ id: "ws-1" });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/workspaces/active",
        expect.objectContaining({
          headers: { Cookie: "session=xyz" },
        }),
      );
    });
  });
});
