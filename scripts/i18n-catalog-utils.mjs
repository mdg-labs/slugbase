/**
 * Shared helpers for repo-JSON i18n catalogs (spec §17, P6-07).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MARKETING_KEY_PREFIX = "marketing.";

const repoRoot = resolve(import.meta.dirname, "..");

export const WEB_LOCALES_DIR = join(repoRoot, "packages/web/app/i18n/locales");
export const SUPPORTED_LOCALES_PATH = join(repoRoot, "i18n/supported-locales.json");

/** @returns {string[]} */
export function readSupportedLocales() {
  const raw = readFileSync(SUPPORTED_LOCALES_PATH, "utf8");
  const locales = JSON.parse(raw);
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new Error(`invalid ${SUPPORTED_LOCALES_PATH}`);
  }
  for (const locale of locales) {
    if (typeof locale !== "string" || locale.length === 0) {
      throw new Error(`invalid locale entry in ${SUPPORTED_LOCALES_PATH}`);
    }
  }
  return locales;
}

/** @param {string} dir @param {string} locale */
export function readLocaleJsonFile(dir, locale) {
  const path = join(dir, `${locale}.json`);
  if (!existsSync(path)) {
    throw new Error(`missing locale file: ${path}`);
  }
  return /** @type {Record<string, string>} */ (JSON.parse(readFileSync(path, "utf8")));
}

/** @param {string} locale */
export function loadPackageLocaleCatalog(locale) {
  return {
    web: readLocaleJsonFile(WEB_LOCALES_DIR, locale),
  };
}

/** @returns {Record<string, string>} merged flat catalog for one locale */
export function loadMergedLocalCatalog(locale) {
  const { web } = loadPackageLocaleCatalog(locale);
  return { ...web };
}

/** @param {Record<string, string>} web @param {Record<string, string>} marketing */
export function mergeLocaleCatalogs(web, marketing) {
  /** @type {Record<string, string>} */
  const merged = { ...web };
  for (const [key, value] of Object.entries(marketing)) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      throw new Error(`i18n catalog key collision between web and marketing: "${key}"`);
    }
    merged[key] = value;
  }
  return merged;
}

/** @param {unknown} obj @param {string} [prefix] */
export function flattenMessages(obj, prefix = "") {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flattenMessages(value, fullKey)) {
        out.set(k, v);
      }
    } else {
      out.set(fullKey, String(value ?? ""));
    }
  }
  return out;
}

/** @param {string} dir @param {string} locale */
export function findLocaleJsonPath(dir, locale) {
  const candidates = [
    join(dir, `${locale}.json`),
    join(dir, locale, `${locale}.json`),
  ];

  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(dir, entry.name, `${locale}.json`));
      }
    }
  }

  return candidates.find((p) => existsSync(p)) ?? null;
}

/** @param {string} dir @param {string} locale */
export function loadLocaleCatalog(dir, locale) {
  const path = findLocaleJsonPath(dir, locale);
  if (!path) {
    throw new Error(`no JSON catalog for locale "${locale}" under ${dir}`);
  }
  const raw = readFileSync(path, "utf8");
  return flattenMessages(JSON.parse(raw));
}

/** @param {Record<string, string>} merged */
export function splitMergedCatalog(merged) {
  /** @type {Record<string, string>} */
  const web = {};
  /** @type {Record<string, string>} */
  const marketing = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith(MARKETING_KEY_PREFIX)) {
      marketing[key] = value;
    } else {
      web[key] = value;
    }
  }
  return { web, marketing };
}

/** @param {string} dir @param {string} locale @param {Record<string, string>} catalog */
export function writeSortedLocaleJson(dir, locale, catalog) {
  mkdirSync(dir, { recursive: true });
  const sorted = Object.fromEntries(
    Object.keys(catalog)
      .sort()
      .map((key) => [key, catalog[key]]),
  );
  writeFileSync(join(dir, `${locale}.json`), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/** @param {Record<string, string>} catalog */
export function findEmptyCatalogKeys(catalog) {
  return Object.entries(catalog)
    .filter(([, value]) => value.trim() === "")
    .map(([key]) => key)
    .sort();
}

/** @param {string[]} before @param {string[]} after */
export function enKeySetChanged(before, after) {
  if (before.length !== after.length) {
    return true;
  }
  const sortedBefore = [...before].sort();
  const sortedAfter = [...after].sort();
  return sortedBefore.some((key, index) => key !== sortedAfter[index]);
}
