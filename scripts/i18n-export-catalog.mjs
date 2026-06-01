#!/usr/bin/env node
/**
 * Export web + marketing staticMessages to Tolgee CLI JSON (JSON_TOLGEE flat keys).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { staticMessages as webMessages } from "../packages/web/app/i18n/messages.ts";
import { staticMessages as marketingMessages } from "../packages/marketing/src/i18n/messages.ts";
import { LOCALES, mergeLocaleCatalogs } from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const exportDir = join(repoRoot, ".tolgee", "export");

mkdirSync(exportDir, { recursive: true });

/** @type {Record<string, number>} */
const counts = {};

for (const locale of LOCALES) {
  const catalog = mergeLocaleCatalogs(
    webMessages[locale],
    marketingMessages[locale],
  );
  counts[locale] = Object.keys(catalog).length;
  writeFileSync(
    join(exportDir, `${locale}.json`),
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );
}

const webEnCount = Object.keys(webMessages.en).length;
const marketingEnCount = Object.keys(marketingMessages.en).length;

console.log(
  `i18n:export: OK — web ${webEnCount} + marketing ${marketingEnCount} = ${counts.en} keys → .tolgee/export/{en,de}.json`,
);
