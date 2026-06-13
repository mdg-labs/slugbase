import {
  staticMessages,
  supportedLocales,
  type MessageKey,
  type SupportedLocale,
} from "./messages.js";

export { supportedLocales, type MessageKey, type SupportedLocale };

/** Resolve a catalog key for the given locale (build-time / SSR). */
export function t(
  locale: SupportedLocale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let text: string = staticMessages[locale][key];
  if (!params) {
    return text;
  }
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
