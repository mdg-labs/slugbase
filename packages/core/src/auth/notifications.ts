import type { MailMessage } from "../ports/mail.ts";

// The emails an account receives about itself (doc 02 section 12). A message is
// named by its template and built from the account as it is when the message is
// sent: a queued job carries the account's identifier and the template, never the
// address or the language, so an address or a language that changed in between is
// the one the message goes to (doc 05 section 2.10).

/** The templates an account notification can name; each one is also a template of `@slugbase/email`. */
export const ACCOUNT_NOTIFICATIONS = ["passwordChanged", "mfaEnabled", "mfaDisabled", "verifyEmail", "newSignIn", "passwordReset", "emailChange", "emailChangeNotice", "ownershipTransferred", "accountDisabled"] as const;

export type AccountNotification = (typeof ACCOUNT_NOTIFICATIONS)[number];

/** What a message to the account needs of it. */
export interface NotificationRecipient {
  readonly email: string;
  /** The account's language; the template falls back to English for one it has no catalog for. */
  readonly locale: string;
  readonly displayName: string;
}

/**
 * The message `template` names, addressed to the account in its own language. `data` is what the template
 * needs beyond the account: the one-time token of the verification, password-reset and email-change emails, which exists only for the length of
 * the send and is never part of a queued job, and the time, browser and network prefix of the "new sign-in"
 * email, which the job carries from the moment the sign-in happened.
 */
export function accountNotification(
  template: AccountNotification,
  recipient: NotificationRecipient,
  data: Readonly<Record<string, string>> = {},
): MailMessage {
  return {
    template,
    to: recipient.email,
    locale: recipient.locale,
    data: { ...data, displayName: recipient.displayName },
  };
}
