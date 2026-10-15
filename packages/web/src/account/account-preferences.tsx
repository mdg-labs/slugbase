import { ShortcutsProvider, useTheme } from "@slugbase/ui";
import { useLayoutEffect, type ReactElement, type ReactNode } from "react";
import { useCachedAccount } from "./use-cached-account.ts";

/**
 * Applies the signed-in account's preferences to the app: the theme and the accent, which the page shows
 * from the moment the account is in, and whether single-key shortcuts are on (doc 03 section 14). Until the
 * account is loaded the page keeps what the browser remembers and shortcuts stay on, the default (Q38).
 */
export function AccountPreferences({ children }: { children: ReactNode }): ReactElement {
  const account = useCachedAccount();
  const { setTheme, setAccent } = useTheme();
  const theme = account?.theme;
  const accent = account?.accent;
  const loaded = account !== undefined;

  useLayoutEffect(() => {
    if (loaded && theme !== undefined) {
      setTheme(theme);
    }
  }, [loaded, theme, setTheme]);

  useLayoutEffect(() => {
    if (loaded && accent !== undefined) {
      setAccent(accent);
    }
  }, [loaded, accent, setAccent]);

  return <ShortcutsProvider singleKey={account?.singleKeyShortcuts ?? true}>{children}</ShortcutsProvider>;
}
