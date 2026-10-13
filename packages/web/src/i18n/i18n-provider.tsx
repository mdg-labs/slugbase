import { useLayoutEffect, useState, type ReactElement, type ReactNode } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { createI18n } from "./create-i18n.ts";
import { DEFAULT_LOCALE } from "./locales.ts";
import { resolveLanguage } from "./resolve-language.ts";

export interface I18nProviderProps {
  /** The signed-in account's language; none until accounts can set one. */
  readonly preference?: string | null | undefined;
  /** `defaultLocale` of `/api/config`. */
  readonly defaultLocale?: string | undefined;
  readonly children: ReactNode;
}

/** Keeps the `lang` attribute of the page on the active language (doc 03 section 15). */
function HtmlLang(): null {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? DEFAULT_LOCALE;
  useLayoutEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return null;
}

/**
 * Provides the translations to the app. The language is resolved from the
 * inputs on every render, so a changed preference or default locale switches
 * the interface without a reload.
 */
export function I18nProvider({ preference, defaultLocale, children }: I18nProviderProps): ReactElement {
  const language = resolveLanguage({ preference, accepted: globalThis.navigator.languages, defaultLocale });
  const [i18n] = useState(() => createI18n(language));
  useLayoutEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, language]);
  return (
    <I18nextProvider i18n={i18n}>
      <HtmlLang />
      {children}
    </I18nextProvider>
  );
}
