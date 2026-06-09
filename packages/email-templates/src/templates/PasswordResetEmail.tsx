/**
 * Password reset email template.
 *
 * Sent when a user requests a password reset. Contains a CTA link to
 * set a new password (1h expiry). Includes a safety note that the
 * password will not be changed unless the link is clicked.
 */

import {
  renderLayout,
  renderCtaButton,
  renderHeading,
  renderParagraph,
  renderNote,
} from "../components/EmailLayout.js";

export interface PasswordResetEmailProps {
  /** The reset URL the user must click. */
  resetUrl: string;
  /** Display name or email prefix for personalization. */
  name?: string;
}

export function renderPasswordResetEmail(
  props: PasswordResetEmailProps,
): string {
  const greeting = props.name
    ? `Hi ${props.name},`
    : "Hi there,";

  const body = `
    ${renderHeading("Reset your password")}
    ${renderParagraph(greeting)}
    ${renderParagraph(
      "We received a request to reset your SlugBase password. Click the button below to choose a new one.",
    )}
    ${renderCtaButton(props.resetUrl, "Reset password")}
    ${renderNote("This link expires in 1 hour.")}
    ${renderNote(
      "Your password will not be changed unless you click the link above and set a new one.",
    )}
  `;

  return renderLayout({ children: body, title: "Reset your password" });
}
