/**
 * Email change verification template.
 *
 * Sent when a user requests an email address change. Contains a CTA link
 * to confirm the new address (24h expiry).
 */

import {
  renderLayout,
  renderCtaButton,
  renderHeading,
  renderParagraph,
  renderNote,
} from "../components/EmailLayout.js";

export interface EmailChangeVerificationEmailProps {
  /** The verification URL to confirm the new address. */
  verifyUrl: string;
  /** The new email address being confirmed. */
  newEmail: string;
}

export function renderEmailChangeVerificationEmail(
  props: EmailChangeVerificationEmailProps,
): string {
  const body = `
    ${renderHeading("Confirm your new email")}
    ${renderParagraph(
      `You requested to change your SlugBase email to <strong style="color:#eceef6;">${props.newEmail}</strong>. Click below to confirm this change.`,
    )}
    ${renderCtaButton(props.verifyUrl, "Confirm new email")}
    ${renderNote(
      "This link expires in 24 hours. If you did not request this change, you can safely ignore this email.",
    )}
  `;

  return renderLayout({ children: body, title: "Confirm your new email" });
}
