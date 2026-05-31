import { FormatSimple, Tolgee } from "@tolgee/web";
import {
  staticMessages,
  supportedLocales,
  type MessageKey,
  type SupportedLocale,
} from "./messages.js";

export { supportedLocales, type MessageKey, type SupportedLocale };

const apiUrl = import.meta.env.PUBLIC_TOLGEE_API_URL;

/** Tolgee instance factory — static catalog + optional live API (spec §17). */
export function createMarketingTolgee(language: SupportedLocale) {
  return Tolgee()
    .use(FormatSimple())
    .init({
      defaultLanguage: "en",
      language,
      apiUrl: apiUrl && apiUrl.length > 0 ? apiUrl : undefined,
      staticData: staticMessages,
    });
}

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

/** Ensure Tolgee static catalog is loaded for a locale (used in tests). */
export async function ensureLocaleLoaded(locale: SupportedLocale): Promise<void> {
  await createMarketingTolgee(locale).run();
}
