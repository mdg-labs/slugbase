import { describe, expect, it, vi } from "vitest";

import { ConfigService } from "../config/config.service.js";
import { validateEnvConfig } from "../config/env.schema.js";
import { validTestEnv } from "../test-utils/test-env.js";
import {
  SLUGBASE_LOGO_CID,
  SLUGBASE_LOGO_FILENAME,
  resolveSlugbaseLogoPath,
} from "@slugbase/email-templates";
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

describe("SmtpMailService", () => {
  it("reports unavailable when SMTP_HOST is not configured", () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const service = new SmtpMailService(config);
    expect(service.isAvailable()).toBe(false);
  });

  it("reports as available when SMTP_HOST is configured", () => {
    const config = buildConfig();
    const service = new SmtpMailService(config);
    expect(service.isAvailable()).toBe(true);
  });

  it("drops messages when transport is not configured", async () => {
    const config = new ConfigService(
      validateEnvConfig({
        ...validTestEnv,
        SMTP_FROM: "noreply@example.com",
      }),
    );
    const service = new SmtpMailService(config);

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
    const service = new SmtpMailService(config);

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
        attachments: [
          {
            filename: SLUGBASE_LOGO_FILENAME,
            path: resolveSlugbaseLogoPath(),
            cid: SLUGBASE_LOGO_CID,
            contentDisposition: "inline",
          },
        ],
      }),
    );
  });

  it("omits logo attachment for plain-text-only messages", async () => {
    const config = buildConfig();
    const service = new SmtpMailService(config);

    const sendMailSpy = vi
      .spyOn(service["transport"], "sendMail")
      .mockResolvedValue({ messageId: "test-id" });

    await service.send({
      to: "recipient@example.com",
      subject: "Test",
      text: "body",
      type: "member_invitation",
    });

    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({
        attachments: expect.anything(),
      }),
    );
  });

  it("throws MailSendError when transport fails", async () => {
    const config = buildConfig();
    const service = new SmtpMailService(config);

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
    const service = new SmtpMailService(config);

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
        attachments: [
          {
            filename: SLUGBASE_LOGO_FILENAME,
            path: resolveSlugbaseLogoPath(),
            cid: SLUGBASE_LOGO_CID,
            contentDisposition: "inline",
          },
        ],
      }),
    );
    const html = sendMailSpy.mock.calls[0]?.[0]?.html as string;
    expect(html).toContain('src="cid:slugbase-logo"');
    expect(html).toContain("safely ignore it");
  });

  it("ensureAvailable reflects env configuration", async () => {
    const configured = new SmtpMailService(buildConfig());
    await expect(configured.ensureAvailable()).resolves.toBe(true);

    const unconfigured = new SmtpMailService(
      new ConfigService(
        validateEnvConfig({
          ...validTestEnv,
          SMTP_FROM: "noreply@example.com",
        }),
      ),
    );
    await expect(unconfigured.ensureAvailable()).resolves.toBe(false);
  });
});
