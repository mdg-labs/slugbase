#!/usr/bin/env node
/**
 * Repo-JSON i18n validation (spec §17, P6-07).
 * 1. Locale parity — every non-default locale has the same keys as en (web).
 * 2. Referenced keys — t("key") in web TSX exist in en.json.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  WEB_LOCALES_DIR,
  findEmptyCatalogKeys,
  readLocaleJsonFile,
  readSupportedLocales,
} from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const webAppDir = join(repoRoot, "packages/web/app");

/** @param {string} dir @param {string[]} acc */
function walkFiles(dir, acc, filter) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "locales" || entry.name === "node_modules") continue;
      walkFiles(path, acc, filter);
    } else if (filter(path)) {
      acc.push(path);
    }
  }
}

/** @param {string} content */
function extractWebTranslationKeys(content) {
  /** @type {Set<string>} */
  const keys = new Set();
  const pattern = /\bt\(\s*["']([a-z][a-z0-9_.]+)["']/g;
  for (const match of content.matchAll(pattern)) {
    keys.add(match[1]);
  }
  return keys;
}

/** @param {Record<string, string>} en @param {Record<string, string>} other @param {string} label */
function checkLocaleParity(en, other, label) {
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const empty = [];

  for (const key of Object.keys(en)) {
    if (!(key in other)) {
      missing.push(key);
    } else if (other[key].trim() === "") {
      empty.push(key);
    }
  }

  /** @type {string[]} */
  const extra = Object.keys(other).filter((key) => !(key in en));

  return { label, missing, empty, extra };
}

/** @param {string[]} lines */
function printSection(lines) {
  for (const line of lines) {
    console.error(line);
  }
}

function main() {
  const locales = readSupportedLocales();
  const defaultLocale = "en";
  /** @type {string[]} */
  const errors = [];

  const webEn = readLocaleJsonFile(WEB_LOCALES_DIR, defaultLocale);

  for (const emptyKey of findEmptyCatalogKeys(webEn)) {
    errors.push(`[web/en] empty value: ${emptyKey}`);
  }

  for (const locale of locales) {
    if (locale === defaultLocale) continue;

    const webOther = readLocaleJsonFile(WEB_LOCALES_DIR, locale);
    const result = checkLocaleParity(webEn, webOther, `web/${locale}`);

    if (result.missing.length > 0) {
      errors.push(
        `[${result.label}] missing ${result.missing.length} key(s) vs en — e.g. ${result.missing.slice(0, 5).join(", ")}`,
      );
    }
    if (result.empty.length > 0) {
      errors.push(
        `[${result.label}] empty ${result.empty.length} key(s) — e.g. ${result.empty.slice(0, 5).join(", ")}`,
      );
    }
    if (result.extra.length > 0) {
      errors.push(
        `[${result.label}] ${result.extra.length} key(s) not in en — e.g. ${result.extra.slice(0, 5).join(", ")}`,
      );
    }
  }

  /** @type {string[]} */
  const webFiles = [];
  walkFiles(webAppDir, webFiles, (path) => path.endsWith(".tsx") && !path.includes(".spec."));

  /** @type {Set<string>} */
  const referencedWebKeys = new Set();
  for (const file of webFiles) {
    const content = readFileSync(file, "utf8");
    for (const key of extractWebTranslationKeys(content)) {
      referencedWebKeys.add(key);
    }
  }

  for (const key of referencedWebKeys) {
    if (!(key in webEn)) {
      errors.push(`[web] t("${key}") referenced in TSX but missing from en.json`);
    }
  }

  if (errors.length > 0) {
    console.error("i18n:validate failed:\n");
    printSection(errors.map((line) => `  - ${line}`));
    process.exit(1);
  }

  console.log(
    `i18n:validate: OK — ${Object.keys(webEn).length} web keys; ${referencedWebKeys.size} web references checked`,
  );
}

main();
