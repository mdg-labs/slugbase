/** Static message catalog — edit locales/*.json; run pnpm i18n:codegen after en.json key changes. */
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
