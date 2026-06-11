/**
 * Transactional mail interface contract (spec §11.1).
 *
 * The application depends only on this contract; implementations are selected
 * by configuration at module init. The no-op default allows the app to run
 * without any mail transport - email-dependent flows degrade gracefully.
 */

export type MailMessageType =
  | "signup_verification"
  | "email_change_verification"
  | "password_reset"
  | "member_invitation"
  | "workspace_invitation"
  | "contact_form_notification";

export interface MailMessage {
  /** Recipient email address. */
  to: string;
  /** Email subject line. */
  subject: string;
  /** Plain-text body (always required). */
  text: string;
  /** Optional HTML body. */
  html?: string;
  /** Logical message type - used for logging and future template selection. */
  type: MailMessageType;
}

export interface MailService {
  /**
   * Send a transactional message.
   * Implementations MUST NOT throw when the transport is unavailable;
   * they MUST log a warning and resolve so email-dependent flows degrade gracefully.
   */
  send(message: MailMessage): Promise<void>;

  /**
   * Returns true when the transport is configured and believed to be operational.
   * Application code can check this before exposing email-dependent features.
   */
  isAvailable(): boolean;

  /**
   * Send a test message to the given address to verify the transport is working.
   * Used by the admin UI's "send test email" action.
   * Resolves on success; rejects with a descriptive error on failure.
   */
  sendTest(to: string): Promise<void>;
}

export class MailSendError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MailSendError";
  }
}
