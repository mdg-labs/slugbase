import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("client-api-path", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("resolveClientApiPath", () => {
    it("returns /api-prefixed path when same-origin (no VITE_API_URL)", async () => {
      vi.stubEnv("VITE_API_URL", "");
      const { resolveClientApiPath } = await import("./client-api-path.js");

      expect(resolveClientApiPath("/folders")).toBe("/api/folders");
      expect(resolveClientApiPath("/tags?pageSize=100")).toBe(
        "/api/tags?pageSize=100",
      );
    });

    it("returns /api-prefixed path when VITE_API_URL is set (hosted)", async () => {
      vi.stubEnv("VITE_API_URL", "https://api.example.com");
      const { resolveClientApiPath } = await import("./client-api-path.js");

      expect(resolveClientApiPath("/folders")).toBe("/api/folders");
      expect(resolveClientApiPath("/tags?pageSize=100")).toBe(
        "/api/tags?pageSize=100",
      );
    });
  });

  describe("getClientApiOrigin", () => {
    it("returns empty string so browser fetch stays same-origin", async () => {
      vi.stubEnv("VITE_API_URL", "https://api.example.com");
      const { getClientApiOrigin } = await import("./client-api-path.js");

      expect(getClientApiOrigin()).toBe("");
    });
  });

  describe("resolveFetchBase", () => {
    it("returns server API base when request is passed", async () => {
      vi.stubEnv("API_BASE_URL", "https://api.example.com");
      const { resolveFetchBase } = await import("./client-api-path.js");
      const request = new Request("https://app.example.com/");

      expect(resolveFetchBase(request)).toBe("https://api.example.com");
    });

    it("returns empty string in browser context", async () => {
      vi.stubEnv("VITE_API_URL", "https://api.example.com");
      const { resolveFetchBase } = await import("./client-api-path.js");

      expect(resolveFetchBase()).toBe("");
    });
  });
});
