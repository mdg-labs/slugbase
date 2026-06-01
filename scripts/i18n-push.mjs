#!/usr/bin/env node
/**
 * Push committed locale JSON to Tolgee (reads push.files from .tolgeerc.json).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readSupportedLocales } from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const apiKey = process.env.TOLGEE_API_KEY?.trim();
if (!apiKey) {
  console.error("i18n:push: TOLGEE_API_KEY is required (set via Infisical env root).");
  process.exit(1);
}

const locales = readSupportedLocales();
const push = spawnSync(
  "pnpm",
  ["exec", "tolgee", "push", "--force-mode", "OVERRIDE", "--languages", ...locales],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);

if (push.status !== 0) {
  process.exit(push.status ?? 1);
}

console.log("i18n:push: OK — Tolgee project synced from committed locale JSON");
