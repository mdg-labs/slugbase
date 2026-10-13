/** Why the SMTP adapter did not send: the message was refused before any connection, or the relay did not take it. */
export type MailErrorReason = "invalid_message" | "unknown_template" | "delivery_failed";

/**
 * The SMTP adapter could not send a message. It carries a reason and nothing of
 * the message or of the relay's answer, so it can be logged and reported as it is.
 */
export class MailError extends Error {
  readonly reason: MailErrorReason;

  constructor(reason: MailErrorReason) {
    super(`the mail could not be sent: ${reason}`);
    this.name = "MailError";
    this.reason = reason;
  }
}
