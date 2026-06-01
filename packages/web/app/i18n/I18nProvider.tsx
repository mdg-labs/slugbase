import { TolgeeProvider, useTolgee } from "@tolgee/react";
import { useEffect, type ReactNode } from "react";
import { AppLocaleProvider, useAppLocale } from "./use-app-locale.js";
import { isAppLocale, type AppLocale } from "./resolve-locale.js";
import { getTolgee } from "./tolgee.js";
import { staticMessages } from "./messages.js";

export type I18nProviderProps = {
  children: ReactNode;
  locale: AppLocale;
};

function LocaleSync() {
  const locale = useAppLocale();
  const tolgeeInstance = useTolgee(["language"]);

  useEffect(() => {
    if (tolgeeInstance.getLanguage() !== locale) {
      void tolgeeInstance.changeLanguage(locale);
    }
    document.documentElement.lang = locale;
  }, [locale, tolgeeInstance]);

  return null;
}

export function I18nProvider({ children, locale }: I18nProviderProps) {
  const activeLocale = isAppLocale(locale) ? locale : "en";

  return (
    <AppLocaleProvider locale={activeLocale}>
      <TolgeeProvider
        tolgee={getTolgee()}
        ssr={{ language: activeLocale, staticData: staticMessages }}
      >
        <LocaleSync />
        {children}
      </TolgeeProvider>
    </AppLocaleProvider>
  );
}
