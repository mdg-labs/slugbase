import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const EMAIL_CHANGE_TEMPLATE = "emailChange";

/** Where the link leads: the confirmation page of the application, on the deployment's own origin (doc 03 section 1.7). */
const CONFIRM_PATH = "/email-change/confirm";

/** The token as the core makes it: 32 bytes as 43 unpadded base64url characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface EmailChangeOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

/**
 * The email-change confirmation (doc 02 section 2.6), mailed to the new address: greets the account by its
 * display name and links to `/email-change/confirm#token=…`. The token is in the fragment, so it reaches neither
 * a server log nor a `Referer` header (doc 04 section 10.3). The message says the link works once and for 1
 * hour. A name that is missing or empty gives a greeting without one; a token that is not the shape the core
 * makes is refused, so no message goes out with a link that cannot work.
 */
export function emailChange({ appName, origin }: EmailChangeOptions): MailTemplate {
  return ({ data, locale }) => {
    const token = data["token"];
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
      throw new RangeError("the email-change email needs the 43-character token of its link");
    }
    const link = `${origin}${CONFIRM_PATH}#token=${token}`;
    const language = resolveLocale(locale);
    const t = translator(language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const greeting = displayName === "" ? t("emailChange.greetingAnonymous") : t("emailChange.greeting", { name: displayName });
    const subject = t("emailChange.subject", { appName });
    const body = t("emailChange.body", { appName });
    const expiry = t("emailChange.expiry");
    const notYou = t("emailChange.notYou");
    const action = t("emailChange.action");
    const footer = t("emailChange.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="margin:0 0 24px 0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(expiry)}</p>`,
      `<p style="margin:0">${escapeHtml(notYou)}</p>`,
    ].join("\n");
    const text = [greeting, body, `${action}: ${link}`, expiry, notYou, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
