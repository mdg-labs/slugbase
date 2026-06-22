import { Inject, Injectable, Logger } from "@nestjs/common";
import { renderMailTransportTestEmail } from "@slugbase/email-templates";
import { MailSendError, type MailMessage, type MailService } from "@slugbase/shared-types";
import nodemailer, { type Transporter } from "nodemailer";

import { ConfigService } from "../config/config.service.js";

/**
 * SMTP-backed mail implementation (spec §11.1, v1 implementation).
 *
 * Transport settings are read from deployment configuration (`SMTP_*` env vars)
 * at construction time. Unconfigured transport reports unavailable and degrades
 * gracefully on send (spec §15).
 */
@Injectable()
export class SmtpMailService implements MailService {
  private readonly logger = new Logger(SmtpMailService.name);
  private readonly transport: Transporter;
  private readonly fromAddress: string;
  private readonly configured: boolean;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const host = config.get("SMTP_HOST");
    const port = config.get("SMTP_PORT");
    const secure = config.get("SMTP_SECURE");
    const user = config.get("SMTP_USER");
    const pass = config.get("SMTP_PASS");

    this.fromAddress = config.get("SMTP_FROM") ?? "noreply@localhost";
    this.configured = Boolean(host);

    this.transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    if (!(await this.ensureAvailable())) {
      this.logger.warn("Mail transport not configured - dropping message", {
        type: message.type,
        to: message.to,
      });
      return;
    }

    try {
      await this.transport.sendMail({
        from: this.fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      this.logger.error("Failed to send mail", {
        type: message.type,
        to: message.to,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new MailSendError(
        `Failed to send ${message.type} to ${message.to}`,
        error,
      );
    }
  }

  isAvailable(): boolean {
    return this.configured;
  }

  ensureAvailable(): Promise<boolean> {
    return Promise.resolve(this.configured);
  }

  async sendTest(to: string): Promise<void> {
    if (!(await this.ensureAvailable())) {
      this.logger.warn("Mail transport not configured - test send skipped", { to });
      return;
    }

    await this.send({
      to,
      subject: "SlugBase mail transport test",
      text: "This is a test message from SlugBase. If you received this, the mail transport is working correctly.",
      html: renderMailTransportTestEmail(),
      type: "mail_transport_test",
    });
  }
}

/** Returns true when a nodemailer failure looks like an SMTP authentication error. */
export function isSmtpAuthFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }

  const withCode = cause as Error & { code?: string; responseCode?: number };
  if (withCode.code === "EAUTH") {
    return true;
  }

  if (withCode.responseCode === 535 || withCode.responseCode === 534) {
    return true;
  }

  const message = cause.message.toLowerCase();
  return (
    message.includes("invalid login") ||
    message.includes("authentication failed") ||
    message.includes("username and password not accepted")
  );
}
