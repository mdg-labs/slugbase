import { BadRequestException } from "@nestjs/common";

/** Preset accent colors aligned with the design system (spec §23). */
export const ALLOWED_ACCENT_COLORS = [
  "#7782f7",
  "#6366f1",
  "#45c98a",
  "#e6b24e",
  "#f0686b",
] as const;

export type AllowedAccentColor = (typeof ALLOWED_ACCENT_COLORS)[number];

const SUPPORTED_LANGUAGES = new Set(["en", "de"]);
const SUPPORTED_THEMES = new Set(["light", "dark", "auto"]);

export function assertLanguageValid(language: string): void {
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new BadRequestException("Unsupported language");
  }
}

export function assertThemeValid(theme: string): void {
  if (!SUPPORTED_THEMES.has(theme)) {
    throw new BadRequestException("Unsupported theme");
  }
}

export function normalizeAccentColor(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

export function assertAccentColorValid(color: string | null): void {
  if (color == null) return;
  const allowed = ALLOWED_ACCENT_COLORS as readonly string[];
  if (!allowed.includes(color)) {
    throw new BadRequestException("Unsupported accent color");
  }
}
