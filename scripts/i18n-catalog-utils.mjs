/**
 * Shared helpers for Tolgee export / push / CI diff (spec §17, P6-07.2).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCALES = ["en", "de"];

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
      `  [${locale}] empty value in repo export (${diff.emptyLocal.length}):`,
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
      `  [${locale}] on Tolgee but not in repo (${diff.orphanOnRemote.length}) — push with removeOtherKeys or delete in Tolgee UI`,
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
      `  [${locale}] value mismatch repo vs Tolgee (${diff.valueMismatch.length}):`,
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
