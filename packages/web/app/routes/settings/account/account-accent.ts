import { ALLOWED_ACCENT_COLORS } from "./account.types.js";

export { ALLOWED_ACCENT_COLORS };

export const ACCENT_PRESET_LABEL_KEYS: Record<
  (typeof ALLOWED_ACCENT_COLORS)[number],
  string
> = {
  "#7782f7": "settings.account.prefs.accent_periwinkle",
  "#6366f1": "settings.account.prefs.accent_indigo",
  "#45c98a": "settings.account.prefs.accent_teal",
  "#e6b24e": "settings.account.prefs.accent_amber",
  "#f0686b": "settings.account.prefs.accent_rose",
};

export function applyUserAccentColor(hex: string | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!hex) {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hover");
    root.style.removeProperty("--accent-active");
    root.style.removeProperty("--accent-text");
    return;
  }
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--accent-text", hex);
}
