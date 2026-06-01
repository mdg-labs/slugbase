#!/usr/bin/env node
/**
 * Spec §22.6 / P6-07.2: merge local JSON, pull Tolgee, strict bidirectional diff.
 * Implements spec "tolgee pull --check" (not a native upstream CLI flag).
 */
import { join, resolve } from "node:path";
import {
  readSupportedLocales,
  diffCatalogs,
  diffHasErrors,
  formatDiffErrors,
  loadLocaleCatalog,
  loadMergedLocalCatalogMap,
  runTolgeePull,
} from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const pullDir = join(repoRoot, ".tolgee", "pull-check");
const locales = readSupportedLocales();

function fail(message) {
  console.error(`tolgee pull --check: ${message}`);
  process.exit(1);
}

try {
  const exitCode = runTolgeePull(pullDir, repoRoot);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/** @type {string[]} */
const allErrors = [];
let keyCount = 0;

for (const locale of locales) {
  const local = loadMergedLocalCatalogMap(locale);
  const remote = loadLocaleCatalog(pullDir, locale);
  if (locale === "en") {
    keyCount = local.size;
  }
  const diff = diffCatalogs(local, remote, locale);
  if (diffHasErrors(diff)) {
    allErrors.push(...formatDiffErrors(diff, locale));
  }
}

if (allErrors.length > 0) {
  console.error("tolgee pull --check: repo catalogs do not match Tolgee:\n");
  for (const line of allErrors) {
    console.error(line);
  }
  process.exit(1);
}

console.log(
  `tolgee pull --check: OK (${keyCount} keys, ${locales.join("+")} match repo JSON and Tolgee)`,
);
