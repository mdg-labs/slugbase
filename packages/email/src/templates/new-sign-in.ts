import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator, type Locale } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const NEW_SIGN_IN_TEMPLATE = "newSignIn";

/** Where the message leads: the security settings of the account, which list its sessions and hold the switch for this email. */
const SECURITY_PATH = "/settings/account/security";

/** The stored prefix of a session: an IPv4 `/16` or an IPv6 `/48`. A longer one would name a single address, which the message never shows. */
const IPV4_PREFIX = /^\d{1,3}(?:\.\d{1,3}){3}\/(\d{1,2})$/;
const IPV6_PREFIX = /^[0-9a-f:]+\/(\d{1,3})$/i;
const LONGEST_IPV4_PREFIX = 16;
const LONGEST_IPV6_PREFIX = 48;

export interface NewSignInOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

function timeOf(value: unknown, language: Locale): string {
  const at = typeof value === "string" ? new Date(value) : undefined;
  if (at === undefined || Number.isNaN(at.getTime())) {
    throw new RangeError("the new sign-in email needs the time of the sign-in as an ISO 8601 string");
  }
  return `${new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(at)} UTC`;
}

function networkOf(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ipv4 = typeof value === "string" ? IPV4_PREFIX.exec(value) : null;
  const ipv6 = typeof value === "string" ? IPV6_PREFIX.exec(value) : null;
  const length = ipv4?.[1] ?? ipv6?.[1];
  if (typeof value !== "string" || length === undefined || Number(length) > (ipv4 === null ? LONGEST_IPV6_PREFIX : LONGEST_IPV4_PREFIX)) {
    throw new RangeError("the new sign-in email shows a network prefix and never a full address");
  }
  return value;
}

/**
 * "A new device signed in" (doc 02 section 12): the time of the sign-in (UTC), the browser family and the
 * coarse network prefix it came from, never a full address. A browser or network that is missing is shown as
 * unknown; a time that is not a time, or a network that is not a prefix, is refused, so no message goes out
 * with a wrong time or an address. The link leads to the security settings, where the sessions are listed and
 * these emails are switched off.
 */
export function newSignIn({ appName, origin }: NewSignInOptions): MailTemplate {
  const link = `${origin}${SECURITY_PATH}`;
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const time = timeOf(data["signedInAt"], language);
    const network = networkOf(data["network"]);
    const browser = typeof data["browser"] === "string" && data["browser"].trim() !== "" ? data["browser"].trim() : t("newSignIn.unknown");
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const greeting = displayName === "" ? t("newSignIn.greetingAnonymous") : t("newSignIn.greeting", { name: displayName });
    const subject = t("newSignIn.subject", { appName });
    const body = t("newSignIn.body", { appName });
    const details = [
      `${t("newSignIn.time")}: ${time}`,
      `${t("newSignIn.browser")}: ${browser}`,
      `${t("newSignIn.network")}: ${network ?? t("newSignIn.unknown")}`,
    ];
    const notYou = t("newSignIn.notYou");
    const turnOff = t("newSignIn.turnOff");
    const action = t("newSignIn.action");
    const footer = t("newSignIn.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${details.map((line) => escapeHtml(line)).join("<br>")}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(notYou)}</p>`,
      `<p style="margin:0 0 24px 0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
      `<p style="margin:0">${escapeHtml(turnOff)}</p>`,
    ].join("\n");
    const text = [greeting, body, details.join("\n"), notYou, `${action}: ${link}`, turnOff, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
