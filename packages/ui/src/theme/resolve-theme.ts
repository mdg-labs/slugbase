import type { ResolvedTheme, ThemePreference } from "./theme-types.js";

/** Maps user preference + system dark mode to an applied `data-theme` value. */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "auto") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}

export function readStoredThemePreference(): ThemePreference | null {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.localStorage.getItem("slugbase-theme-preference");
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }
  return null;
}

export function persistThemePreference(preference: ThemePreference): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem("slugbase-theme-preference", preference);
}
