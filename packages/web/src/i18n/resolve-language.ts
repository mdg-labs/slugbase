import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales.ts";

export interface LanguageInputs {
  /** The signed-in account's language, once accounts can set one. */
  readonly preference?: string | null | undefined;
  /** The browser's accepted languages, most preferred first. */
  readonly accepted?: readonly string[] | undefined;
  /** `defaultLocale` of `/api/config`. */
  readonly defaultLocale?: string | undefined;
}

/** The supported locale a language tag such as `de-AT` or `de_DE` belongs to, if any. */
export function supportedLocale(tag: string | null | undefined): Locale | undefined {
  const primary = tag?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return LOCALES.find((locale) => locale === primary);
}

/**
 * The language of the interface: the account preference, then the browser's
 * accepted languages, then the server's default locale, then English
 * (doc 02 section 15). A candidate that is not one of the catalogs is skipped.
 */
export function resolveLanguage({ preference, accepted = [], defaultLocale }: LanguageInputs): Locale {
  for (const candidate of [preference, ...accepted, defaultLocale]) {
    const locale = supportedLocale(candidate);
    if (locale !== undefined) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}
