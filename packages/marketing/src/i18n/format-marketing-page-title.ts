import { staticMessages, type MessageKey, type SupportedLocale } from "./messages.js";

/** Build a browser tab title: `SlugBase | {page}` (spec #457). */
export function formatMarketingPageTitle(
  locale: SupportedLocale,
  pageKey: MessageKey,
): string {
  const messages = staticMessages[locale];
  const brand = messages["marketing.nav.brand"];
  const page = messages[pageKey];
  const template = messages["marketing.document_title"];
  return template.replaceAll("{brand}", brand).replaceAll("{page}", page);
}

/** Brand-only tab title (landing page). */
export function formatMarketingBrandTitle(locale: SupportedLocale): string {
  return staticMessages[locale]["marketing.nav.brand"];
}
