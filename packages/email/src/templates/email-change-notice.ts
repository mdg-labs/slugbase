import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const EMAIL_CHANGE_NOTICE_TEMPLATE = "emailChangeNotice";

/** Where the link leads: the "this wasn't me" page of the application, on the deployment's own origin (doc 03 section 1.7). */
const CANCEL_PATH = "/email-change/cancel";

/** The token as the core makes it: 32 bytes as 43 unpadded base64url characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface EmailChangeNoticeOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

/**
 * The notice of a requested email change (doc 02 section 2.6), mailed to the old address: says that a change
 * was requested and takes effect only once the new address confirms it, and links to
 * `/email-change/cancel#token=…`, the "this wasn't me" link, which cancels the change and signs every device
 * out. The token is in the fragment, so it reaches neither a server log nor a `Referer` header (doc 04 section
 * 10.3). The message says the link works once and for 1 hour. A name that is missing or empty gives a greeting
 * without one; a token that is not the shape the core makes is refused, so no message goes out with a link that
 * cannot work.
 */
export function emailChangeNotice({ appName, origin }: EmailChangeNoticeOptions): MailTemplate {
  return ({ data, locale }) => {
    const token = data["token"];
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
      throw new RangeError("the email-change notice needs the 43-character token of its link");
    }
    const link = `${origin}${CANCEL_PATH}#token=${token}`;
    const language = resolveLocale(locale);
    const t = translator(language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const greeting = displayName === "" ? t("emailChangeNotice.greetingAnonymous") : t("emailChangeNotice.greeting", { name: displayName });
    const subject = t("emailChangeNotice.subject", { appName });
    const body = t("emailChangeNotice.body", { appName });
    const notYou = t("emailChangeNotice.notYou");
    const expiry = t("emailChangeNotice.expiry");
    const itWasYou = t("emailChangeNotice.itWasYou");
    const action = t("emailChangeNotice.action");
    const footer = t("emailChangeNotice.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(notYou)}</p>`,
      `<p style="margin:0 0 24px 0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(expiry)}</p>`,
      `<p style="margin:0">${escapeHtml(itWasYou)}</p>`,
    ].join("\n");
    const text = [greeting, body, notYou, `${action}: ${link}`, expiry, itWasYou, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
