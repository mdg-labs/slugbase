import type { ReactElement, ReactNode } from "react";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { I18nProvider } from "./i18n-provider.tsx";

/**
 * The app's `I18nProvider` with the account's language as its preference (doc 02 section 15). Saving a
 * new language updates the cached account, which switches the interface at once, without a reload.
 */
export function AccountI18nProvider({ defaultLocale, children }: { defaultLocale: string; children: ReactNode }): ReactElement {
  return (
    <I18nProvider defaultLocale={defaultLocale} preference={useCachedAccount()?.locale}>
      {children}
    </I18nProvider>
  );
}
