import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const EXPORT_ONLY_TEMPLATE = "exportOnly";

export interface ExportOnlyOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

/** The end of the period as the core hands it over, an RFC 3339 instant, written in the recipient's language and in UTC. */
function endOf(value: unknown, language: string): string {
  const at = typeof value === "string" ? new Date(value) : undefined;
  if (at === undefined || Number.isNaN(at.getTime())) {
    throw new RangeError("the export-only email needs the time the period ends, as an RFC 3339 instant");
  }
  return `${new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(at)} UTC`;
}

/**
 * "Your account is export-only until ..." (doc 02 sections 2.11 and 12): an instance administrator left the account a period in which it
 * can sign in and take its data out and nothing else, and says when the period ends. The link opens the page that exports on the
 * deployment's own origin. A message without an end date is a mistake of the sender, so the template refuses it.
 */
export function exportOnly({ appName, origin }: ExportOnlyOptions): MailTemplate {
  const link = `${origin}/settings/account/data`;
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const until = endOf(data["until"], language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].replace(/\s+/g, " ").trim() : "";
    const greeting = displayName === "" ? t("exportOnly.greetingAnonymous") : t("exportOnly.greeting", { name: displayName });
    const subject = t("exportOnly.subject", { appName });
    const body = t("exportOnly.body", { appName, until });
    const how = t("exportOnly.how", { appName });
    const action = t("exportOnly.action");
    const footer = t("exportOnly.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="margin:0 0 24px 0">${escapeHtml(how)}</p>`,
      `<p style="margin:0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
    ].join("\n");
    const text = [greeting, body, how, `${action}: ${link}`, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}
