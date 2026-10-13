import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "slugbase-theme";

const THEMES: readonly Theme[] = ["light", "dark", "system"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export interface ThemeContextValue {
  /** The member's choice. */
  theme: Theme;
  /** What the document shows: the choice, or the system preference when the choice is `system`. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

// Storage can be missing or throw (blocked cookies, private mode, quota); a
// theme that cannot be remembered still works for the session.
function readStoredTheme(storageKey: string): Theme | undefined {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return isTheme(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function storeTheme(storageKey: string, theme: Theme): void {
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Not remembered; the choice still applies until the page is closed.
  }
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function serverSystemTheme(): boolean {
  return true;
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** The choice used until the member makes one. Defaults to `system` (Q35). */
  defaultTheme?: Theme;
  /** The `localStorage` key that keeps the choice. */
  storageKey?: string;
}

/**
 * Keeps the light, dark or system choice and applies it as a `light` or `dark`
 * class on the root element, which `theme.css` styles. The class is set from
 * script that ships with the app bundle, so no inline script is needed and a
 * `script-src 'self'` policy holds. Until account preferences exist (Phase 2)
 * the choice lives in `localStorage` alone.
 */
export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = THEME_STORAGE_KEY,
}: ThemeProviderProps): ReactElement {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(storageKey) ?? defaultTheme);
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark, serverSystemTheme);
  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      storeTheme(storageKey, next);
    },
    [storageKey],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used inside a ThemeProvider");
  }
  return value;
}
