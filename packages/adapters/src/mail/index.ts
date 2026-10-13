export { MailError } from "./errors.ts";
export type { MailErrorReason } from "./errors.ts";
export { createLogOnlyMail } from "./log-only.ts";
export type { MailLogger } from "./log-only.ts";
export { createSmtpMail } from "./smtp.ts";
export type { CreateSmtpMailOptions, SmtpSecurity } from "./smtp.ts";
export type { MailTemplate, MailTemplateInput, MailTemplates, RenderedMail } from "./templates.ts";
