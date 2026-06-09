/**
 * Signup verification email template.
 *
 * Sent when a new user creates an account. Contains a CTA link to verify
 * their email address (24h expiry).
 */

import {
  renderLayout,
  renderCtaButton,
  renderHeading,
  renderParagraph,
  renderNote,
} from "../components/EmailLayout.js";

export interface SignupVerificationEmailProps {
  /** The verification URL the user must click. */
  verifyUrl: string;
  /** Display name or email prefix for personalization. */
  name?: string;
}

export function renderSignupVerificationEmail(
  props: SignupVerificationEmailProps,
): string {
  const greeting = props.name
    ? `Hi ${props.name},`
    : "Hi there,";

  const body = `
    ${renderHeading("Verify your email")}
    ${renderParagraph(greeting)}
    ${renderParagraph(
      "Thanks for signing up for SlugBase. Click the button below to verify your email address and get started.",
    )}
    ${renderCtaButton(props.verifyUrl, "Verify email address")}
    ${renderNote("This link expires in 24 hours.")}
  `;

  return renderLayout({ children: body, title: "Verify your email" });
}
