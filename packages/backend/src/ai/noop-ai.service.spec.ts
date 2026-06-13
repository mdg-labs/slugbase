import { describe, expect, it, vi } from "vitest";

import { NoopAiService } from "./noop-ai.service.js";

describe("NoopAiService", () => {
  it("reports as unavailable", () => {
    const service = new NoopAiService();
    expect(service.isAvailable()).toBe(false);
  });

  it("rejects suggest with AiUnavailableError", async () => {
    const service = new NoopAiService();
    await expect(
      service.suggest({
        url: "https://example.com",
        outputLanguage: "en",
      }),
    ).rejects.toMatchObject({ name: "AiUnavailableError" });
  });

  it("logs a warning when suggest is called", async () => {
    const service = new NoopAiService();
    const warnSpy = vi.spyOn(service["logger"], "warn");

    await expect(
      service.suggest({
        url: "https://example.com/docs",
        outputLanguage: "de",
      }),
    ).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      "AI provider not configured - suggestion skipped",
      expect.objectContaining({
        url: "https://example.com/docs",
        outputLanguage: "de",
      }),
    );
  });
});
