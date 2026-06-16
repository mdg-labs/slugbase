import type { MessageKey } from "../i18n/messages.js";
import { staticMessages, type SupportedLocale } from "../i18n/messages.js";

/** Build a browser tab title: `SlugBase | {page}` (spec #457). */
export function formatDocumentTitle(
  locale: SupportedLocale,
  pageKey: MessageKey,
): string {
  const messages = staticMessages[locale];
  const brand = messages["app.shell.brand"];
  const page = messages[pageKey];
  const template = messages["app.document_title"];
  return template.replaceAll("{brand}", brand).replaceAll("{page}", page);
}

/** Brand-only title (e.g. landing parity). */
export function formatDocumentTitleBrandOnly(locale: SupportedLocale): string {
  return staticMessages[locale]["app.shell.brand"];
}
