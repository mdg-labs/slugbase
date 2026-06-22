import { describe, expect, it, vi } from "vitest";

import { ConfigService } from "../config/config.service.js";
import { validateEnvConfig } from "../config/env.schema.js";
import { AesGcmCryptoService } from "../crypto/aes-gcm-crypto.service.js";
import { validTestEnv } from "../test-utils/test-env.js";
import { SmtpMailService } from "./smtp-mail.service.js";

function buildConfig(overrides: NodeJS.ProcessEnv = {}): ConfigService {
  return new ConfigService(
    validateEnvConfig({
      ...validTestEnv,
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USER: "user@example.com",
      SMTP_PASS: "s3cr3t",
      SMTP_FROM: "noreply@example.com",
      ...overrides,
    }),
  );
}

function buildCrypto(config: ConfigService): AesGcmCryptoService {
  return new AesGcmCryptoService(config);
}

describe("SmtpMailService", () => {
  it("reports unavailable when SMTP_HOST is not configured", () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const service = new SmtpMailService(config, buildCrypto(config));
    expect(service.isAvailable()).toBe(false);
  });

  it("reports as available when SMTP_HOST is configured", () => {
    const config = buildConfig();
    const service = new SmtpMailService(config, buildCrypto(config));
    expect(service.isAvailable()).toBe(true);
  });

  it("drops messages when transport is not configured", async () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const service = new SmtpMailService(config, buildCrypto(config));

    const sendMailSpy = vi.spyOn(service["transport"], "sendMail");

    await service.send({
      to: "recipient@example.com",
      subject: "Test",
      text: "body",
      type: "member_invitation",
    });

    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("calls transport.sendMail with the correct payload", async () => {
    const config = buildConfig();
    const service = new SmtpMailService(config, buildCrypto(config));

    const sendMailSpy = vi
      .spyOn(service["transport"], "sendMail")
      .mockResolvedValue({ messageId: "test-id" });

    await service.send({
      to: "recipient@example.com",
      subject: "Password reset",
      text: "Click here to reset.",
      html: "<p>Click here to reset.</p>",
      type: "password_reset",
    });

    expect(sendMailSpy).toHaveBeenCalledOnce();
    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "noreply@example.com",
        to: "recipient@example.com",
        subject: "Password reset",
        text: "Click here to reset.",
        html: "<p>Click here to reset.</p>",
      }),
    );
  });

  it("throws MailSendError when transport fails", async () => {
    const config = buildConfig();
    const service = new SmtpMailService(config, buildCrypto(config));

    vi.spyOn(service["transport"], "sendMail").mockRejectedValue(
      new Error("Connection refused"),
    );

    const { MailSendError } = await import("@slugbase/shared-types");
    await expect(
      service.send({
        to: "recipient@example.com",
        subject: "Test",
        text: "body",
        type: "member_invitation",
      }),
    ).rejects.toBeInstanceOf(MailSendError);
  });

  it("sendTest sends branded HTML and plain-text fallback", async () => {
    const config = buildConfig();
    const service = new SmtpMailService(config, buildCrypto(config));

    const sendMailSpy = vi
      .spyOn(service["transport"], "sendMail")
      .mockResolvedValue({ messageId: "test-id" });

    await service.sendTest("admin@example.com");

    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        subject: "SlugBase mail transport test",
        text: "This is a test message from SlugBase. If you received this, the mail transport is working correctly.",
        html: expect.stringContaining("mail transport is working correctly"),
      }),
    );
    const html = sendMailSpy.mock.calls[0]?.[0]?.html as string;
    expect(html).toContain('src="cid:slugbase-logo"');
    expect(html).toContain("safely ignore it");
  });

  it("reconfigureFromEncrypted decrypts credentials and rebuilds transport", () => {
    const config = buildConfig();
    const crypto = buildCrypto(config);
    const service = new SmtpMailService(config, crypto);

    const encryptedUser = crypto.encrypt("newuser@example.com");
    const encryptedPass = crypto.encrypt("newpassword123");

    const originalTransport = service["transport"];
    service.reconfigureFromEncrypted({
      host: "new-smtp.example.com",
      port: 465,
      secure: true,
      encryptedUser,
      encryptedPass,
      from: "new@example.com",
    });

    expect(service["transport"]).not.toBe(originalTransport);
    expect(service["fromAddress"]).toBe("new@example.com");
    expect(service.isAvailable()).toBe(true);
  });

  it("ensureAvailable hydrates from DB when runtime is injected", async () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const mailRuntime = {
      hydrateIfNeeded: vi.fn().mockResolvedValue(true),
    };
    const service = new SmtpMailService(
      config,
      buildCrypto(config),
      mailRuntime as never,
    );

    await expect(service.ensureAvailable()).resolves.toBe(true);
    expect(mailRuntime.hydrateIfNeeded).toHaveBeenCalledOnce();
  });

  it("ensureAvailable returns false without hydrator when env SMTP is absent", async () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const service = new SmtpMailService(config, buildCrypto(config));

    await expect(service.ensureAvailable()).resolves.toBe(false);
  });

  it("send triggers lazy hydration before delivering", async () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const crypto = buildCrypto(config);
    const mailRuntime = {
      hydrateIfNeeded: vi.fn(),
    };
    const service = new SmtpMailService(config, crypto, mailRuntime as never);
    mailRuntime.hydrateIfNeeded.mockImplementation(() => {
      service.reconfigureFromEncrypted({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "user@example.com",
        from: "noreply@example.com",
      });
      vi.spyOn(service["transport"], "sendMail").mockResolvedValue({ messageId: "test-id" });
      return Promise.resolve(true);
    });

    await service.send({
      to: "recipient@example.com",
      subject: "Test",
      text: "body",
      type: "member_invitation",
    });

    expect(mailRuntime.hydrateIfNeeded).toHaveBeenCalledOnce();
    expect(service["transport"].sendMail).toHaveBeenCalledOnce();
  });
});
