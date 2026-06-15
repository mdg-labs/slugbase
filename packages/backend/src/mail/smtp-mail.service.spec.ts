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

  it("sendTest sends to the given address", async () => {
    const config = buildConfig();
    const service = new SmtpMailService(config, buildCrypto(config));

    const sendMailSpy = vi
      .spyOn(service["transport"], "sendMail")
      .mockResolvedValue({ messageId: "test-id" });

    await service.sendTest("admin@example.com");

    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" }),
    );
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
  });
});
