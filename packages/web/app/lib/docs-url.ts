const DOCS_BASE_URL_ENV_KEY = "VITE_DOCS_BASE_URL";
const DEFAULT_DOCS_BASE_URL = "https://docs.slugbase.app";

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

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

/** Normalizes a public docs origin URL (no trailing slash). */
export function parseDocsBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DOCS_BASE_URL;
  }
  return raw.trim().replace(/\/+$/, "");
}

/** Docs site origin from `VITE_DOCS_BASE_URL`, or the production default when unset. */
export function getDocsBaseUrl(): string {
  return parseDocsBaseUrl(readEnv(DOCS_BASE_URL_ENV_KEY));
}

/**
 * Cloud vs CE from the build-time `VITE_BILLING_ENABLED` flag (spec §15 edition preset).
 * Defaults to CE when unset.
 */
export function isCloudDocsBuild(): boolean {
  return readBoolean(readEnv("VITE_BILLING_ENABLED"), false);
}

/** Product-aware docs introduction URL for the active web build profile. */
export function buildDocsIntroductionUrl(): string {
  const base = getDocsBaseUrl();
  const segment = isCloudDocsBuild() ? "cloud" : "ce";
  return `${base}/${segment}/introduction`;
}
