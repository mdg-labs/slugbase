import { PortUnavailable, type MailPort } from "@slugbase/core";

/** Where the log-only adapter writes. The server's logger satisfies it. */
export interface MailLogger {
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

// What follows the last @ of an address, kept only when it is a plain host name.
function recipientDomain(address: string): string {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return address.includes("@") && /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : "unknown";
}

/**
 * The mail port of an instance with no SMTP relay (D22). It is not available,
 * and a send rejects with `mail_unavailable` after writing one log line: the
 * recipient's domain and the template that named the message. Nothing else of
 * the message is written (T7).
 */
export function createLogOnlyMail(options: { readonly logger: MailLogger }): MailPort {
  return {
    available: false,
    send(message) {
      options.logger.warn("Mail is not configured; the message was not sent", {
        recipientDomain: recipientDomain(message.to),
        template: message.template,
      });
      return Promise.reject(new PortUnavailable("mail", "mail_unavailable"));
    },
  };
}
