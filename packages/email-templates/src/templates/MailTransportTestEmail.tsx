/**
 * SMTP mail transport test email template.
 *
 * Sent when an admin uses "send test email" to verify SMTP configuration.
 */

import {
  renderLayout,
  renderHeading,
  renderParagraph,
} from "../components/EmailLayout.js";

export function renderMailTransportTestEmail(): string {
  const body = `
    ${renderHeading("Mail transport test")}
    ${renderParagraph(
      "This is a test message from SlugBase. If you received this, the mail transport is working correctly.",
    )}
  `;

  return renderLayout({
    children: body,
    title: "SlugBase mail transport test",
  });
}
