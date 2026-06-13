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

  describe("getApiBaseUrl", () => {
    it("returns empty string so browser fetch stays same-origin", async () => {
      vi.stubEnv("VITE_API_URL", "https://api.example.com");
      const { getApiBaseUrl } = await import("./client-api-path.js");

      expect(getApiBaseUrl()).toBe("");
    });
  });
});
