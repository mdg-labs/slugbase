#!/usr/bin/env node
/**
 * Spec §22.6 / P6-07.2: export repo catalogs, pull Tolgee, strict bidirectional diff.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LOCALES,
  diffCatalogs,
  diffHasErrors,
  formatDiffErrors,
  loadLocaleCatalog,
} from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const exportDir = join(repoRoot, ".tolgee", "export");
const pullDir = join(repoRoot, ".tolgee", "pull-check");

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

const exportStep = spawnSync(
  "pnpm",
  ["exec", "tsx", "scripts/i18n-export-catalog.mjs"],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);
if (exportStep.status !== 0) {
  process.exit(exportStep.status ?? 1);
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
    ...LOCALES,
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

/** @type {string[]} */
const allErrors = [];
let keyCount = 0;

for (const locale of LOCALES) {
  const local = loadLocaleCatalog(exportDir, locale);
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
  `tolgee pull --check: OK (${keyCount} keys, en+de match repo export and Tolgee)`,
);
