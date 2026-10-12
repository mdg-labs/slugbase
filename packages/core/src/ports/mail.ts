import type { Port } from "./port.js";

/** A typed transactional message: the template names the message, the data fills it. */
export interface MailMessage {
  readonly template: string;
  readonly to: string;
  readonly locale: string;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

/** Sends transactional mail and reports whether it can (doc 01 section 6). */
export interface MailPort extends Port {
  send(message: MailMessage): Promise<void>;
}
