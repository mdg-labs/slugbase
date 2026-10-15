import type { MailMessage } from "../ports/mail.ts";

// The emails an account receives about itself (doc 02 section 12). A message is
// named by its template and built from the account as it is when the message is
// sent: a queued job carries the account's identifier and the template, never the
// address or the language, so an address or a language that changed in between is
// the one the message goes to (doc 05 section 2.10).

/** The templates an account notification can name; each one is also a template of `@slugbase/email`. */
export const ACCOUNT_NOTIFICATIONS = ["passwordChanged", "mfaEnabled", "mfaDisabled"] as const;

export type AccountNotification = (typeof ACCOUNT_NOTIFICATIONS)[number];

/** What a message to the account needs of it. */
export interface NotificationRecipient {
  readonly email: string;
  /** The account's language; the template falls back to English for one it has no catalog for. */
  readonly locale: string;
  readonly displayName: string;
}

/** The message `template` names, addressed to the account in its own language. */
export function accountNotification(template: AccountNotification, recipient: NotificationRecipient): MailMessage {
  return {
    template,
    to: recipient.email,
    locale: recipient.locale,
    data: { displayName: recipient.displayName },
  };
}
