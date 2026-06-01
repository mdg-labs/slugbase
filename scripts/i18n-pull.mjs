#!/usr/bin/env node
/**
 * Pull Tolgee translations into committed locale JSON (split web / marketing).
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  WEB_LOCALES_DIR,
  MARKETING_LOCALES_DIR,
  readSupportedLocales,
  loadLocaleCatalog,
  loadMergedLocalCatalogMap,
  loadPackageLocaleCatalog,
  planPullApply,
  runTolgeePull,
  writeSortedLocaleJson,
  findEmptyCatalogKeys,
  enKeySetChanged,
  diffHasErrors,
} from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const pullDir = join(repoRoot, ".tolgee", "pull");

function fail(message) {
  console.error(`i18n:pull: ${message}`);
  process.exit(1);
}

const exitCode = runTolgeePull(pullDir, repoRoot);
if (exitCode !== 0) {
  process.exit(exitCode);
}

const locales = readSupportedLocales();
const defaultLocale = locales[0];
if (!defaultLocale) {
  fail("supported-locales.json is empty");
}

/** @type {Array<ReturnType<typeof planPullApply> & { locale: string, remoteMap: Map<string, string> }>} */
const plans = [];

for (const locale of locales) {
  const localMap = loadMergedLocalCatalogMap(locale);
  const remoteMap = loadLocaleCatalog(pullDir, locale);
  const plan = planPullApply({ localMap, remoteMap });
  plans.push({ ...plan, locale, remoteMap });
}

for (const plan of plans) {
  if (!plan.canApply) {
    fail(`[${plan.locale}] ${plan.blockReason}`);
  }
}

const webEnBefore = Object.keys(loadPackageLocaleCatalog(defaultLocale).web);
const marketingEnBefore = Object.keys(
  loadPackageLocaleCatalog(defaultLocale).marketing,
);

/** @type {Array<{ locale: string, stats: NonNullable<typeof plans[0]["stats"]>, orphans: string[] }>} */
const localeSummaries = [];
let totalValueUpdates = 0;
let totalOrphansAdded = 0;
let anyChanges = false;

for (const plan of plans) {
  const diff = plan.diff;
  if (!diff || !plan.stats || !plan.web || !plan.marketing) {
    continue;
  }

  const localeChanged = diffHasErrors(diff);
  if (!localeChanged) {
    continue;
  }

  anyChanges = true;
  totalValueUpdates += plan.stats.valueUpdates;
  totalOrphansAdded += plan.stats.orphansAdded;

  const emptyWeb = findEmptyCatalogKeys(plan.web);
  const emptyMarketing = findEmptyCatalogKeys(plan.marketing);
  if (plan.locale === defaultLocale && (emptyWeb.length > 0 || emptyMarketing.length > 0)) {
    fail(
      `pulled ${defaultLocale} has empty values (web: ${emptyWeb.length}, marketing: ${emptyMarketing.length})`,
    );
  }

  writeSortedLocaleJson(WEB_LOCALES_DIR, plan.locale, plan.web);
  writeSortedLocaleJson(MARKETING_LOCALES_DIR, plan.locale, plan.marketing);

  localeSummaries.push({
    locale: plan.locale,
    stats: plan.stats,
    orphans: diff.orphanOnRemote,
  });
}

if (!anyChanges) {
  console.log("i18n:pull: OK — repo catalogs already match Tolgee (no file changes)");
  process.exit(0);
}

const webEnAfter = Object.keys(loadPackageLocaleCatalog(defaultLocale).web);
const marketingEnAfter = Object.keys(
  loadPackageLocaleCatalog(defaultLocale).marketing,
);
const enKeysChanged =
  enKeySetChanged(webEnBefore, webEnAfter) ||
  enKeySetChanged(marketingEnBefore, marketingEnAfter);

if (enKeysChanged) {
  const codegen = spawnSync("pnpm", ["i18n:codegen"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (codegen.status !== 0) {
    process.exit(codegen.status ?? 1);
  }
}

console.log(
  `i18n:pull: OK — updated locale JSON (${totalValueUpdates} value update(s), ${totalOrphansAdded} key(s) added from Tolgee)`,
);

for (const { locale, stats, orphans } of localeSummaries) {
  console.log(
    `  [${locale}] ${stats.valueUpdates} value update(s), ${stats.orphansAdded} new key(s) (web: ${stats.orphansAddedWeb}, marketing: ${stats.orphansAddedMarketing})`,
  );
  if (orphans.length > 0) {
    console.warn(
      `  [${locale}] warning: ${orphans.length} key(s) added from Tolgee only — ensure t() references exist in code`,
    );
    for (const key of orphans.slice(0, 10)) {
      console.warn(`    - ${key}`);
    }
    if (orphans.length > 10) {
      console.warn(`    … and ${orphans.length - 10} more`);
    }
  }
}
