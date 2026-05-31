export type ThemePreference = "light" | "dark" | "auto";

export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "slugbase-theme-preference" as const;

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "dark";
