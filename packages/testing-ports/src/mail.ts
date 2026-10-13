/** A message handed to `InMemoryMail`: the shape of `MailMessage` in `@slugbase/core`, which this package cannot import. */
export interface InMemoryMailMessage {
  readonly template: string;
  readonly to: string;
  readonly locale: string;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

// The recipient rule of the SMTP adapter, copied here because this package
// imports no workspace package: one plain mailbox, no line break, list,
// display name or group.
const SINGLE_ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/;

/**
 * A mail port that keeps every message it is given instead of sending it
 * (doc 08 section 3.1), so a test reads what a flow would have mailed. A
 * message is copied on the way in: changing the object afterwards does not
 * change what was captured. A recipient that is not a single plain address is
 * rejected without capturing the message, as the SMTP adapter refuses it.
 */
export class InMemoryMail {
  readonly available = true;
  readonly #sent: InMemoryMailMessage[] = [];

  /** Every message sent so far, in order. */
  get sent(): readonly InMemoryMailMessage[] {
    return [...this.#sent];
  }

  send(message: InMemoryMailMessage): Promise<void> {
    if (!SINGLE_ADDRESS.test(message.to)) return Promise.reject(new Error("invalid_message"));
    this.#sent.push({ template: message.template, to: message.to, locale: message.locale, data: { ...message.data } });
    return Promise.resolve();
  }

  /** Forgets the messages captured so far. */
  clear(): void {
    this.#sent.length = 0;
  }
}
