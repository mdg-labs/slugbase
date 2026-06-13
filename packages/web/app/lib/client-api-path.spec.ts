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

    it("returns direct path when cross-origin (VITE_API_URL set)", async () => {
      vi.stubEnv("VITE_API_URL", "https://api.example.com");
      const { resolveClientApiPath } = await import("./client-api-path.js");

      expect(resolveClientApiPath("/folders")).toBe("/folders");
      expect(resolveClientApiPath("/tags?pageSize=100")).toBe(
        "/tags?pageSize=100",
      );
      expect(resolveClientApiPath("/folders")).not.toBe("/api/folders");
    });

    it("returns direct path when API_BASE_URL is set", async () => {
      vi.stubEnv("API_BASE_URL", "https://api.example.com");
      const { resolveClientApiPath } = await import("./client-api-path.js");

      expect(resolveClientApiPath("/bookmarks")).toBe("/bookmarks");
    });
  });

  describe("getApiBaseUrl", () => {
    it("returns empty string when no API origin is configured", async () => {
      vi.stubEnv("VITE_API_URL", "");
      const { getApiBaseUrl } = await import("./client-api-path.js");

      expect(getApiBaseUrl()).toBe("");
    });

    it("strips trailing slash from VITE_API_URL", async () => {
      vi.stubEnv("VITE_API_URL", "https://api.example.com/");
      const { getApiBaseUrl } = await import("./client-api-path.js");

      expect(getApiBaseUrl()).toBe("https://api.example.com");
    });
  });
});
