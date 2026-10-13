import type { MailPort } from "@slugbase/core";
import { createTransport } from "nodemailer";
import { MailError } from "./errors.ts";
import type { MailTemplates } from "./templates.ts";
import { areSafeHeaders, isSafeSubject, isSingleRecipient } from "./validate.ts";

/**
 * How the connection is secured. `tls` connects over TLS from the first byte
 * (usually port 465), `starttls` upgrades the connection and refuses to send
 * without it (usually port 587), `none` stays in plain text.
 */
export type SmtpSecurity = "tls" | "starttls" | "none";

export interface CreateSmtpMailOptions {
  /** The relay. Operator configuration: it is never taken from a request or from stored content. */
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly auth?: { readonly user: string; readonly pass: string };
  /** The sender of every message: an address, or a display name and an address in angle brackets. */
  readonly from: string;
  readonly templates: MailTemplates;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The mail port over a generic SMTP relay (Q9). It renders the template a message
 * names, refuses a recipient, subject or header with a line break, and sends one
 * multipart message with a text and an HTML part. The relay's certificate is
 * verified against its host name, and the connection is made to the configured
 * host and port only. A failure rejects with a `MailError` that names the reason
 * and carries nothing of the message or of the relay's answer.
 */
export function createSmtpMail(options: CreateSmtpMailOptions): MailPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = createTransport({
    host: options.host,
    port: options.port,
    secure: options.security === "tls",
    requireTLS: options.security === "starttls",
    ignoreTLS: options.security === "none",
    ...(options.auth === undefined ? {} : { auth: { user: options.auth.user, pass: options.auth.pass } }),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return {
    available: true,
    async send(message) {
      if (!isSingleRecipient(message.to)) {
        throw new MailError("invalid_message");
      }
      const template = Object.hasOwn(options.templates, message.template) ? options.templates[message.template] : undefined;
      if (template === undefined) {
        throw new MailError("unknown_template");
      }
      const rendered = template({ data: message.data, locale: message.locale });
      if (!isSafeSubject(rendered.subject) || !areSafeHeaders(rendered.headers ?? {})) {
        throw new MailError("invalid_message");
      }
      try {
        await transport.sendMail({
          from: options.from,
          to: message.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          ...(rendered.headers === undefined ? {} : { headers: { ...rendered.headers } }),
        });
      } catch {
        throw new MailError("delivery_failed");
      }
    },
  };
}
