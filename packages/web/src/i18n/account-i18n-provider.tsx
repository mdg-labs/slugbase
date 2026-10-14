import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { ME_QUERY_KEY, type Me } from "../account/me.ts";
import { I18nProvider } from "./i18n-provider.tsx";

/**
 * The language the signed-in account chose, once the app holds the account. It reads the cache and
 * asks for nothing: a page that loads the account (the profile page) is what puts it there, and sign-out
 * clears it.
 */
function useAccountLocale(): string | undefined {
  const queryClient = useQueryClient();
  return useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () => queryClient.getQueryData<Me>(ME_QUERY_KEY)?.account.locale,
  );
}

/**
 * The app's `I18nProvider` with the account's language as its preference (doc 02 section 15). Saving a
 * new language updates the cached account, which switches the interface at once, without a reload.
 */
export function AccountI18nProvider({ defaultLocale, children }: { defaultLocale: string; children: ReactNode }): ReactElement {
  return (
    <I18nProvider defaultLocale={defaultLocale} preference={useAccountLocale()}>
      {children}
    </I18nProvider>
  );
}
