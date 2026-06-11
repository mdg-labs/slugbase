import { describe, expect, it, vi } from "vitest";

import { NoopMailService } from "./noop-mail.service.js";

describe("NoopMailService", () => {
  it("reports as unavailable", () => {
    const service = new NoopMailService();
    expect(service.isAvailable()).toBe(false);
  });

  it("resolves without throwing on send", async () => {
    const service = new NoopMailService();
    await expect(
      service.send({
        to: "user@example.com",
        subject: "Test",
        text: "Hello",
        type: "password_reset",
      }),
    ).resolves.toBeUndefined();
  });

  it("logs a warning when send is called", async () => {
    const service = new NoopMailService();
    const warnSpy = vi.spyOn(service["logger"], "warn");

    await service.send({
      to: "user@example.com",
      subject: "Test",
      text: "Hello",
      type: "signup_verification",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "Mail transport not configured - dropping message",
      expect.objectContaining({ type: "signup_verification", to: "user@example.com" }),
    );
  });

  it("resolves without throwing on sendTest", async () => {
    const service = new NoopMailService();
    await expect(service.sendTest("admin@example.com")).resolves.toBeUndefined();
  });

  it("logs a warning when sendTest is called", async () => {
    const service = new NoopMailService();
    const warnSpy = vi.spyOn(service["logger"], "warn");

    await service.sendTest("admin@example.com");

    expect(warnSpy).toHaveBeenCalledWith(
      "Mail transport not configured - test send skipped",
      expect.objectContaining({ to: "admin@example.com" }),
    );
  });
});
