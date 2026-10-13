import { createInstance, type i18n as I18n, type Resource } from "i18next";
import ICU from "i18next-icu";
import { CATALOGS, DEFAULT_LOCALE, LOCALES, type Locale } from "./locales.ts";

const BUNDLED: Resource = {
  en: { translation: CATALOGS.en },
  de: { translation: CATALOGS.de },
};

/**
 * An i18next instance reading ICU messages from the bundled catalogs, ready
 * before it returns because the resources are inline. `resources` replaces the
 * catalogs, for tests of the message syntax.
 */
export function createI18n(language: Locale, resources: Resource = BUNDLED): I18n {
  const instance = createInstance();
  void instance.use(ICU).init({
    lng: language,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LOCALES,
    resources,
    initAsync: false,
    // React escapes what it renders; escaping here would show `&amp;` to the reader.
    interpolation: { escapeValue: false },
  });
  return instance;
}
