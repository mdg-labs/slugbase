import { createContext, useContext, type ReactNode, useEffect, useMemo, useState } from "react";

import { type AppLocale, isAppLocale } from "./resolve-locale.js";

type AppLocaleContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
};

const defaultContextValue: AppLocaleContextValue = {
  locale: "en",
  setLocale: () => {},
};

const AppLocaleContext = createContext<AppLocaleContextValue>(defaultContextValue);

export type AppLocaleProviderProps = {
  children: ReactNode;
  locale: AppLocale;
};

/** Keeps active UI locale in sync with the root loader and preference saves. */
export function AppLocaleProvider({ children, locale }: AppLocaleProviderProps) {
  const resolved = isAppLocale(locale) ? locale : "en";
  const [activeLocale, setActiveLocale] = useState<AppLocale>(resolved);

  useEffect(() => {
    setActiveLocale(resolved);
  }, [resolved]);

  const value = useMemo(
    () => ({ locale: activeLocale, setLocale: setActiveLocale }),
    [activeLocale],
  );

  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

/** Active UI locale for formatting and client-only display helpers. */
export function useAppLocale(): AppLocale {
  return useContext(AppLocaleContext).locale;
}

/** Update locale after the user saves a language preference. */
export function useSetAppLocale(): (locale: AppLocale) => void {
  return useContext(AppLocaleContext).setLocale;
}
