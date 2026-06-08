import { I18nextProvider } from "react-i18next";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppLocaleProvider, useAppLocale } from "./use-app-locale.js";
import { isAppLocale, type AppLocale } from "./resolve-locale.js";
import { createI18n } from "./i18n.js";

export type I18nProviderProps = {
  children: ReactNode;
  locale: AppLocale;
};

function LocaleSync() {
  const locale = useAppLocale();
  const { i18n } = useTranslation();

  useEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
    document.documentElement.lang = locale;
  }, [locale, i18n]);

  return null;
}

export function I18nProvider({ children, locale }: I18nProviderProps) {
  const activeLocale = isAppLocale(locale) ? locale : "en";
  const i18n = useMemo(() => createI18n(activeLocale), [activeLocale]);

  return (
    <AppLocaleProvider locale={activeLocale}>
      <I18nextProvider i18n={i18n}>
        <LocaleSync />
        {children}
      </I18nextProvider>
    </AppLocaleProvider>
  );
}
