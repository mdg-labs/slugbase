#!/usr/bin/env node
/**
 * Export repo catalogs and push en/de to Tolgee project (spec §17).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const apiKey = process.env.TOLGEE_API_KEY?.trim();
if (!apiKey) {
  console.error("i18n:push: TOLGEE_API_KEY is required (set via Infisical env root).");
  process.exit(1);
}

run("pnpm", ["exec", "tsx", "scripts/i18n-export-catalog.mjs"], "export");

run(
  "pnpm",
  [
    "exec",
    "tolgee",
    "push",
    "--force-mode",
    "OVERRIDE",
    "--languages",
    "en",
    "de",
  ],
  "push",
);

console.log("i18n:push: OK — Tolgee project synced from repo catalogs");
