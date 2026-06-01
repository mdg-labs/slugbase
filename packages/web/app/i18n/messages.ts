/** Tolgee catalog wrapper — edit locales/*.json; push new keys; pull translations from Tolgee. */
import en from "./locales/en.json";
import de from "./locales/de.json";
import type { MessageKey } from "./message-keys.generated.js";

export type { MessageKey };

export const staticMessages = {
  en,
  de,
} as const;

export type SupportedLocale = keyof typeof staticMessages;

export const supportedLocales = Object.keys(staticMessages) as SupportedLocale[];
