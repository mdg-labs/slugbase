import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const PASSWORD_CHANGED_TEMPLATE = "passwordChanged";

/** Where the message leads: the security settings of the account, on the deployment's own origin. */
const SECURITY_PATH = "/settings/account/security";

export interface PasswordChangedOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

/**
 * "Your password was changed" (doc 02 section 12): the account's display name
 * greets the reader, the message says that the other devices were signed out and
 * links to the security settings. A name that is missing or empty gives a greeting
 * without one.
 */
export function passwordChanged({ appName, origin }: PasswordChangedOptions): MailTemplate {
  const link = `${origin}${SECURITY_PATH}`;
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const greeting = displayName === "" ? t("passwordChanged.greetingAnonymous") : t("passwordChanged.greeting", { name: displayName });
    const subject = t("passwordChanged.subject", { appName });
    const body = t("passwordChanged.body", { appName });
    const notYou = t("passwordChanged.notYou", { appName });
    const action = t("passwordChanged.action");
    const footer = t("layout.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="margin:0 0 24px 0">${escapeHtml(notYou)}</p>`,
      `<p style="margin:0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
    ].join("\n");
    const text = [greeting, body, notYou, `${action}: ${link}`, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
