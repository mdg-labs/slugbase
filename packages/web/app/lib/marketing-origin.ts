import type { SupportedLocale } from "../i18n/messages.js";

export type MarketingLegalPage = "impressum" | "datenschutz" | "agb";

const MARKETING_ORIGIN_ENV_KEY = "VITE_MARKETING_ORIGIN";

function readEnv(key: string): string | undefined {
  if (typeof import.meta !== "undefined" && key in import.meta.env) {
    const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const nodeValue = process.env[key];
  return typeof nodeValue === "string" && nodeValue.trim().length > 0
    ? nodeValue.trim()
    : undefined;
}

/** Normalizes a public origin URL (no trailing slash). Returns null when unset. */
export function parseMarketingOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  return raw.trim().replace(/\/+$/, "");
}

/** Marketing site origin from `VITE_MARKETING_ORIGIN`, or null when unset (self-host). */
export function getMarketingOrigin(): string | null {
  return parseMarketingOrigin(readEnv(MARKETING_ORIGIN_ENV_KEY));
}

function localePathPrefix(locale: SupportedLocale): string {
  return locale === "de" ? "/de" : "";
}

/** Absolute marketing legal URL for the locale, or null when origin is unset. */
export function buildMarketingLegalUrl(
  locale: SupportedLocale,
  page: MarketingLegalPage,
): string | null {
  const origin = getMarketingOrigin();
  if (!origin) {
    return null;
  }
  return `${origin}${localePathPrefix(locale)}/legal/${page}`;
}
