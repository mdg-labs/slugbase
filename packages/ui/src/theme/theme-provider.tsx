import { CSPProvider } from "@base-ui/react/csp-provider";
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

/** The six accent presets of Q36; `theme.css` styles each as a `data-accent` value. Periwinkle is the default and needs no attribute. */
export type Accent = "periwinkle" | "violet" | "rose" | "amber" | "green" | "teal";
export const ACCENTS: readonly Accent[] = ["periwinkle", "violet", "rose", "amber", "green", "teal"];

export const THEME_STORAGE_KEY = "slugbase-theme";
export const ACCENT_STORAGE_KEY = "slugbase-accent";

const THEMES: readonly Theme[] = ["light", "dark", "system"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export interface ThemeContextValue {
  /** The member's choice. */
  theme: Theme;
  /** What the document shows: the choice, or the system preference when the choice is `system`. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** The accent preset the member chose; null while none was, which shows the default. */
  accent: Accent | null;
  setAccent: (accent: Accent | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

function isAccent(value: unknown): value is Accent {
  return ACCENTS.some((accent) => accent === value);
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

function readStoredAccent(storageKey: string): Accent | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return isAccent(stored) ? stored : null;
  } catch {
    return null;
  }
}

function store(storageKey: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(storageKey);
    } else {
      window.localStorage.setItem(storageKey, value);
    }
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
  /** The `localStorage` key that keeps the accent. */
  accentStorageKey?: string;
}

/**
 * Keeps the light, dark or system choice and applies it as a `light` or `dark`
 * class on the root element, which `theme.css` styles. The class is set from
 * script that ships with the app bundle, so no inline script is needed and a
 * `script-src 'self'` policy holds. Base UI adds a `<style>` element for the
 * scroll area and the select popup, which a policy without `'unsafe-inline'`
 * blocks; the provider turns that element off and `theme.css` carries its rule,
 * so the policy needs no source for inline styles. The accent is a
 * `data-accent` attribute on the root element. Both choices live in
 * `localStorage`, which the page shows until the app applies the account's own.
 */
export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = THEME_STORAGE_KEY,
  accentStorageKey = ACCENT_STORAGE_KEY,
}: ThemeProviderProps): ReactElement {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(storageKey) ?? defaultTheme);
  const [accent, setAccentState] = useState<Accent | null>(() => readStoredAccent(accentStorageKey));
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark, serverSystemTheme);
  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (accent === null) {
      root.removeAttribute("data-accent");
    } else {
      root.setAttribute("data-accent", accent);
    }
  }, [accent]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      store(storageKey, next);
    },
    [storageKey],
  );

  const setAccent = useCallback(
    (next: Accent | null) => {
      setAccentState(next);
      store(accentStorageKey, next);
    },
    [accentStorageKey],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, accent, setAccent }),
    [theme, resolvedTheme, setTheme, accent, setAccent],
  );

  return (
    <ThemeContext.Provider value={value}>
      <CSPProvider disableStyleElements>{children}</CSPProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used inside a ThemeProvider");
  }
  return value;
}
