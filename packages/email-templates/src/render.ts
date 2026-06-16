/**
 * Public render functions for all transactional email templates.
 *
 * Each function takes template-specific props and returns a complete
 * HTML string (inline-styled, dark-themed) ready for the `html` field
 * of the mail interface's `MailMessage` (spec section 11.1).
 */

export { renderSignupVerificationEmail } from "./templates/SignupVerificationEmail.js";
export type { SignupVerificationEmailProps } from "./templates/SignupVerificationEmail.js";

export { renderEmailChangeVerificationEmail } from "./templates/EmailChangeVerificationEmail.js";
export type { EmailChangeVerificationEmailProps } from "./templates/EmailChangeVerificationEmail.js";

export { renderPasswordResetEmail } from "./templates/PasswordResetEmail.js";
export type { PasswordResetEmailProps } from "./templates/PasswordResetEmail.js";

export { renderWorkspaceInvitationEmail } from "./templates/WorkspaceInvitationEmail.js";
export type { WorkspaceInvitationEmailProps } from "./templates/WorkspaceInvitationEmail.js";

export { renderContactFormNotificationEmail } from "./templates/ContactFormNotificationEmail.js";
export type { ContactFormNotificationEmailProps } from "./templates/ContactFormNotificationEmail.js";

export { renderMailTransportTestEmail } from "./templates/MailTransportTestEmail.js";
