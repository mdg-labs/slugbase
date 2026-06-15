import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("consent-api", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("persistAnalyticsConsent", () => {
    it("does not POST when CSRF token fetch fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
      });

      const { persistAnalyticsConsent } = await import("./consent-api.js");

      await expect(persistAnalyticsConsent(true)).rejects.toThrow(
        "Failed to fetch CSRF token",
      );

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/auth/csrf-token",
        expect.any(Object),
      );
    });

    it("POSTs consent with CSRF token when fetch succeeds", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ csrfToken: "tok-1" }),
        })
        .mockResolvedValueOnce({ ok: true });

      const { persistAnalyticsConsent } = await import("./consent-api.js");
      await persistAnalyticsConsent(true);

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        "/analytics/consent",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-csrf-token": "tok-1" }),
        }),
      );
    });
  });
});
