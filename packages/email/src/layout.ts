import { escapeHtml } from "./html.ts";
import type { Locale } from "./translate.ts";

// The shared frame of every transactional email: a single centred column in a
// table with inline styles, which mail clients render alike. It carries no image,
// no remote stylesheet, no script and no tracking element (doc 02 section 12). Every
// value is escaped here; `content` is the one argument that is HTML, and its
// producer escapes what it puts in it.

export interface LayoutOptions {
  readonly locale: Locale;
  readonly title: string;
  readonly appName: string;
  readonly footer: string;
  /** The HTML of the message body, already escaped. */
  readonly content: string;
}

const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

export const PARAGRAPH_STYLE = "margin:0 0 16px 0";

export const BUTTON_STYLE = "display:inline-block;padding:10px 20px;border-radius:6px;background-color:#4f46e5;color:#ffffff;text-decoration:none";

export function layout({ locale, title, appName, footer, content }: LayoutOptions): string {
  return [
    "<!DOCTYPE html>",
    `<html lang="${locale}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:${FONT};color:#18181b">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5"><tbody><tr>',
    '<td align="center" style="padding:32px 16px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:8px"><tbody>',
    `<tr><td style="padding:24px 32px 0 32px;font-size:18px;font-weight:600">${escapeHtml(appName)}</td></tr>`,
    `<tr><td style="padding:16px 32px 32px 32px;font-size:15px;line-height:24px">${content}</td></tr>`,
    "</tbody></table>",
    `<p style="max-width:560px;margin:16px 0 0 0;font-size:12px;line-height:18px;color:#71717a">${escapeHtml(footer)}</p>`,
    "</td></tr></tbody></table>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
