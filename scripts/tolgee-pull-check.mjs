#!/usr/bin/env node
/**
 * Spec §22.6 / P6-07.2: `tolgee pull --check` semantics.
 * Upstream @tolgee/cli has no `--check` flag; pull en+de then fail on missing/empty translations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const pullDir = join(repoRoot, ".tolgee", "pull-check");
const defaultLocale = "en";
const requiredLocales = ["en", "de"];

function fail(message) {
  console.error(`tolgee pull --check: ${message}`);
  process.exit(1);
}

const apiKey = process.env.TOLGEE_API_KEY?.trim();
const projectId = process.env.TOLGEE_PROJECT_ID?.trim() || "4";
const apiUrl =
  process.env.VITE_TOLGEE_API_URL?.trim() || "https://tolgee.mdg-labs.dev";

if (!apiKey) {
  fail("TOLGEE_API_KEY is required (set via Infisical env root).");
}

rmSync(pullDir, { recursive: true, force: true });

const pull = spawnSync(
  "pnpm",
  [
    "exec",
    "tolgee",
    "pull",
    "--path",
    pullDir,
    "--languages",
    ...requiredLocales,
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

if (pull.status !== 0) {
  process.exit(pull.status ?? 1);
}

function loadLocaleFile(locale) {
  const candidates = [
    join(pullDir, `${locale}.json`),
    join(pullDir, locale, `${locale}.json`),
  ];

  for (const root of [pullDir, ...readdirSync(pullDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(pullDir, e.name))]) {
    candidates.push(join(root, `${locale}.json`));
  }

  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    fail(`no pulled file for locale "${locale}" under ${pullDir}`);
  }

  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function flattenMessages(obj, prefix = "") {
  const out = new Map();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flattenMessages(value, fullKey)) {
        out.set(k, v);
      }
    } else {
      out.set(fullKey, value);
    }
  }
  return out;
}

const enMessages = flattenMessages(loadLocaleFile(defaultLocale));
const deMessages = flattenMessages(loadLocaleFile("de"));

const missingInDe = [];
const emptyInDe = [];

for (const [key, enValue] of enMessages) {
  if (enValue === undefined || enValue === null || String(enValue).trim() === "") {
    fail(`default locale key "${key}" has an empty English value on Tolgee`);
  }

  const deValue = deMessages.get(key);
  if (deValue === undefined) {
    missingInDe.push(key);
  } else if (String(deValue).trim() === "") {
    emptyInDe.push(key);
  }
}

if (missingInDe.length > 0 || emptyInDe.length > 0) {
  if (missingInDe.length > 0) {
    console.error(
      `Missing German translation for ${missingInDe.length} key(s):`,
    );
    for (const key of missingInDe.slice(0, 20)) {
      console.error(`  - ${key}`);
    }
    if (missingInDe.length > 20) {
      console.error(`  … and ${missingInDe.length - 20} more`);
    }
  }
  if (emptyInDe.length > 0) {
    console.error(`Empty German translation for ${emptyInDe.length} key(s):`);
    for (const key of emptyInDe.slice(0, 20)) {
      console.error(`  - ${key}`);
    }
    if (emptyInDe.length > 20) {
      console.error(`  … and ${emptyInDe.length - 20} more`);
    }
  }
  process.exit(1);
}

console.log(
  `tolgee pull --check: OK (${enMessages.size} keys, en+de complete on Tolgee)`,
);
