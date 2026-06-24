/**
 * @slugbase/email-templates - dark-themed transactional email templates
 *
 * Provides inline-styled HTML rendering for all SlugBase transactional
 * email types (spec section 11.1, section 23 design tokens).
 *
 * @packageDocumentation
 */

export { renderLayout } from "./components/EmailLayout.js";
export type { EmailLayoutProps } from "./components/EmailLayout.js";

export {
  SLUGBASE_LOGO_CID,
  SLUGBASE_LOGO_FILENAME,
  resolveSlugbaseLogoPath,
} from "./logo.js";

export {
  renderSignupVerificationEmail,
  renderEmailChangeVerificationEmail,
  renderPasswordResetEmail,
  renderWorkspaceInvitationEmail,
  renderContactFormNotificationEmail,
  renderMailTransportTestEmail,
} from "./render.js";

export type {
  SignupVerificationEmailProps,
  EmailChangeVerificationEmailProps,
  PasswordResetEmailProps,
  WorkspaceInvitationEmailProps,
  ContactFormNotificationEmailProps,
} from "./render.js";
