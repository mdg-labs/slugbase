import { escapeHtml } from "../html.ts";
import { PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const TEST_MAIL_TEMPLATE = "testMail";

export interface TestMailOptions {
  readonly appName: string;
}

/**
 * The test email an instance admin sends to themselves (doc 02 section 11.3): it says that delivery works and
 * links nowhere. The footer says why it arrived, since the usual one speaks of a change to the account.
 */
export function testMail({ appName }: TestMailOptions): MailTemplate {
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const greeting = displayName === "" ? t("testMail.greetingAnonymous") : t("testMail.greeting", { name: displayName });
    const subject = t("testMail.subject", { appName });
    const body = t("testMail.body", { appName });
    const footer = t("testMail.footer", { appName });

    const content = [`<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`, `<p style="margin:0">${escapeHtml(body)}</p>`].join("\n");
    const text = [greeting, body, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
