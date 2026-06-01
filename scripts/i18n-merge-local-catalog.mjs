#!/usr/bin/env node
/**
 * Dev sanity: print merged local catalog key counts from committed JSON.
 */
import {
  readSupportedLocales,
  loadMergedLocalCatalog,
  readLocaleJsonFile,
  WEB_LOCALES_DIR,
  MARKETING_LOCALES_DIR,
} from "./i18n-catalog-utils.mjs";

const locales = readSupportedLocales();
const webEn = Object.keys(readLocaleJsonFile(WEB_LOCALES_DIR, "en")).length;
const marketingEn = Object.keys(readLocaleJsonFile(MARKETING_LOCALES_DIR, "en")).length;
const mergedEn = Object.keys(loadMergedLocalCatalog("en")).length;

console.log(
  `i18n:merge: web ${webEn} + marketing ${marketingEn} = ${mergedEn} keys (${locales.join("+")} locales in i18n/supported-locales.json)`,
);
