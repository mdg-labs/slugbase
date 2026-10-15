import { PASSWORD_CHANGED_TEMPLATE, passwordChanged } from "./templates/password-changed.ts";
import type { MailTemplates } from "./types.ts";

export type { MailTemplate, MailTemplateInput, MailTemplates, RenderedMail } from "./types.ts";

/** The name every message of SlugBase carries; the catalogs take it as `{appName}`. */
const APP_NAME = "SlugBase";

export interface MailTemplateOptions {
  /** `APP_ORIGIN`. Every link of every message points to it and nowhere else. */
  readonly appOrigin: string;
}

/**
 * The templates the mail adapter can send, keyed by the name a `MailMessage`
 * carries. The origin is the deployment's, fixed here: no message takes a link or
 * a host from its data.
 */
export function createMailTemplates({ appOrigin }: MailTemplateOptions): MailTemplates {
  const { origin, protocol } = new URL(appOrigin);
  if (protocol !== "https:" && protocol !== "http:") {
    throw new RangeError("the application origin of the mail templates must be an http or https origin");
  }
  return { [PASSWORD_CHANGED_TEMPLATE]: passwordChanged({ appName: APP_NAME, origin }) };
}
