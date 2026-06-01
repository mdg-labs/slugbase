/**
 * Shared helpers for Tolgee push / pull / CI diff (spec §17, P6-07.2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MARKETING_KEY_PREFIX = "marketing.";

const repoRoot = resolve(import.meta.dirname, "..");

export const WEB_LOCALES_DIR = join(repoRoot, "packages/web/app/i18n/locales");
export const MARKETING_LOCALES_DIR = join(
  repoRoot,
  "packages/marketing/src/i18n/locales",
);
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
    marketing: readLocaleJsonFile(MARKETING_LOCALES_DIR, locale),
  };
}

/** @returns {Record<string, string>} merged flat catalog for one locale */
export function loadMergedLocalCatalog(locale) {
  const { web, marketing } = loadPackageLocaleCatalog(locale);
  return mergeLocaleCatalogs(web, marketing);
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

/**
 * @param {Map<string, string>} local
 * @param {Map<string, string>} remote
 * @param {string} locale
 */
export function diffCatalogs(local, remote, locale) {
  /** @type {{ missingOnRemote: string[], orphanOnRemote: string[], valueMismatch: string[], emptyLocal: string[], emptyRemote: string[] }} */
  const result = {
    missingOnRemote: [],
    orphanOnRemote: [],
    valueMismatch: [],
    emptyLocal: [],
    emptyRemote: [],
  };

  for (const [key, localValue] of local) {
    if (localValue.trim() === "") {
      result.emptyLocal.push(key);
      continue;
    }
    const remoteValue = remote.get(key);
    if (remoteValue === undefined) {
      result.missingOnRemote.push(key);
    } else if (remoteValue.trim() === "") {
      result.emptyRemote.push(key);
    } else if (remoteValue !== localValue) {
      result.valueMismatch.push(key);
    }
  }

  for (const key of remote.keys()) {
    if (!local.has(key)) {
      result.orphanOnRemote.push(key);
    }
  }

  if (result.missingOnRemote.length > 0) {
    result.missingOnRemote.sort();
  }
  if (result.orphanOnRemote.length > 0) {
    result.orphanOnRemote.sort();
  }
  if (result.valueMismatch.length > 0) {
    result.valueMismatch.sort();
  }
  if (result.emptyLocal.length > 0) {
    result.emptyLocal.sort();
  }
  if (result.emptyRemote.length > 0) {
    result.emptyRemote.sort();
  }

  void locale;
  return result;
}

/** @param {ReturnType<typeof diffCatalogs>} diff @param {string} locale */
export function formatDiffErrors(diff, locale) {
  /** @type {string[]} */
  const lines = [];

  if (diff.emptyLocal.length > 0) {
    lines.push(
      `  [${locale}] empty value in repo catalogs (${diff.emptyLocal.length}):`,
    );
    for (const key of diff.emptyLocal.slice(0, 15)) {
      lines.push(`    - ${key}`);
    }
    if (diff.emptyLocal.length > 15) {
      lines.push(`    … and ${diff.emptyLocal.length - 15} more`);
    }
  }

  if (diff.missingOnRemote.length > 0) {
    lines.push(
      `  [${locale}] on repo but missing on Tolgee (${diff.missingOnRemote.length}) — run: pnpm i18n:push`,
    );
    for (const key of diff.missingOnRemote.slice(0, 15)) {
      lines.push(`    - ${key}`);
    }
    if (diff.missingOnRemote.length > 15) {
      lines.push(`    … and ${diff.missingOnRemote.length - 15} more`);
    }
  }

  if (diff.orphanOnRemote.length > 0) {
    lines.push(
      `  [${locale}] on Tolgee but not in repo (${diff.orphanOnRemote.length}) — run: pnpm i18n:pull`,
    );
    for (const key of diff.orphanOnRemote.slice(0, 15)) {
      lines.push(`    - ${key}`);
    }
    if (diff.orphanOnRemote.length > 15) {
      lines.push(`    … and ${diff.orphanOnRemote.length - 15} more`);
    }
  }

  if (diff.emptyRemote.length > 0) {
    lines.push(
      `  [${locale}] empty on Tolgee (${diff.emptyRemote.length}):`,
    );
    for (const key of diff.emptyRemote.slice(0, 15)) {
      lines.push(`    - ${key}`);
    }
    if (diff.emptyRemote.length > 15) {
      lines.push(`    … and ${diff.emptyRemote.length - 15} more`);
    }
  }

  if (diff.valueMismatch.length > 0) {
    lines.push(
      `  [${locale}] value mismatch repo vs Tolgee (${diff.valueMismatch.length}) — run: pnpm i18n:pull`,
    );
    for (const key of diff.valueMismatch.slice(0, 15)) {
      lines.push(`    - ${key}`);
    }
    if (diff.valueMismatch.length > 15) {
      lines.push(`    … and ${diff.valueMismatch.length - 15} more`);
    }
  }

  return lines;
}

/** @param {ReturnType<typeof diffCatalogs>} diff */
export function diffHasErrors(diff) {
  return (
    diff.missingOnRemote.length > 0 ||
    diff.orphanOnRemote.length > 0 ||
    diff.valueMismatch.length > 0 ||
    diff.emptyLocal.length > 0 ||
    diff.emptyRemote.length > 0
  );
}

/** @returns {Map<string, string>} */
export function loadMergedLocalCatalogMap(locale) {
  return flattenMessages(loadMergedLocalCatalog(locale));
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

/** @param {Map<string, string>} remoteMap */
export function splitMergedCatalogMap(remoteMap) {
  return splitMergedCatalog(Object.fromEntries(remoteMap));
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

/** @returns {{ apiKey: string | undefined, projectId: string, apiUrl: string }} */
export function getTolgeeEnv() {
  return {
    apiKey: process.env.TOLGEE_API_KEY?.trim(),
    projectId: process.env.TOLGEE_PROJECT_ID?.trim() || "4",
    apiUrl: process.env.VITE_TOLGEE_API_URL?.trim() || "https://tolgee.mdg-labs.dev",
  };
}

/**
 * @param {string} targetDir
 * @param {string} repoRoot
 * @returns {number} exit code
 */
export function runTolgeePull(targetDir, repoRoot) {
  const locales = readSupportedLocales();
  const { apiKey, projectId, apiUrl } = getTolgeeEnv();
  if (!apiKey) {
    throw new Error("TOLGEE_API_KEY is required (set via Infisical env root).");
  }

  rmSync(targetDir, { recursive: true, force: true });

  const pull = spawnSync(
    "pnpm",
    [
      "exec",
      "tolgee",
      "pull",
      "--path",
      targetDir,
      "--languages",
      ...locales,
      "--states",
      "UNTRANSLATED",
      "TRANSLATED",
      "REVIEWED",
      "--empty-dir",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        TOLGEE_API_KEY: apiKey,
        TOLGEE_PROJECT_ID: projectId,
        VITE_TOLGEE_API_URL: apiUrl,
      },
    },
  );

  return pull.status ?? 1;
}

/**
 * @param {{ localMap: Map<string, string>, remoteMap: Map<string, string> }} params
 */
export function planPullApply({ localMap, remoteMap }) {
  const diff = diffCatalogs(localMap, remoteMap, "apply");
  if (diff.missingOnRemote.length > 0) {
    return {
      canApply: false,
      blockReason: `repo has ${diff.missingOnRemote.length} key(s) not on Tolgee — run pnpm i18n:push first`,
      diff,
      stats: {
        valueUpdates: 0,
        orphansAdded: 0,
        orphansAddedWeb: 0,
        orphansAddedMarketing: 0,
      },
    };
  }

  const { web, marketing } = splitMergedCatalogMap(remoteMap);
  const orphans = diff.orphanOnRemote;
  const orphansAddedMarketing = orphans.filter((key) =>
    key.startsWith(MARKETING_KEY_PREFIX),
  ).length;
  const orphansAddedWeb = orphans.length - orphansAddedMarketing;

  return {
    canApply: true,
    web,
    marketing,
    diff,
    stats: {
      valueUpdates: diff.valueMismatch.length,
      orphansAdded: orphans.length,
      orphansAddedWeb,
      orphansAddedMarketing,
    },
  };
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
