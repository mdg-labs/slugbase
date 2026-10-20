import type { NotificationRecipient } from "../auth/notifications.ts";
import type { MailMessage } from "../ports/mail.ts";

// The test email an instance admin sends to themselves (doc 02 section 11.3). Like an account notification it is built
// from the account as it is when the message is sent, so the job that sends it carries the account's identifier only.

/** The template of the test email; it is also a template of `@slugbase/email`. */
export const INSTANCE_TEST_MAIL_TEMPLATE = "testMail";

/** The test message to the account, in the account's language. */
export function instanceTestMail(recipient: NotificationRecipient): MailMessage {
  return { template: INSTANCE_TEST_MAIL_TEMPLATE, to: recipient.email, locale: recipient.locale, data: { displayName: recipient.displayName } };
}
