import { escapeHtml } from "../html.ts";
import { PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const ACCOUNT_DISABLED_TEMPLATE = "accountDisabled";

export interface AccountDisabledOptions {
  readonly appName: string;
}

/**
 * "Your account was disabled" (doc 02 sections 11.2 and 12): an instance administrator disabled the account, so it
 * cannot sign in and its sessions and API tokens have stopped working. The message links nowhere, since nothing in
 * the application is open to the reader any more, and points to the administrator of the instance.
 */
export function accountDisabled({ appName }: AccountDisabledOptions): MailTemplate {
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const greeting = displayName === "" ? t("accountDisabled.greetingAnonymous") : t("accountDisabled.greeting", { name: displayName });
    const subject = t("accountDisabled.subject", { appName });
    const body = t("accountDisabled.body", { appName });
    const help = t("accountDisabled.help", { appName });
    const footer = t("accountDisabled.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="margin:0">${escapeHtml(help)}</p>`,
    ].join("\n");
    const text = [greeting, body, help, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
