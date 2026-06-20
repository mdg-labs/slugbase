import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SYNC_SECRETS_MANIFEST,
  type SyncSecretsService,
} from "./sync-secrets-manifest.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SYNC_SCRIPT = resolve(REPO_ROOT, ".github/scripts/sync-secrets.sh");

function readSyncScript(): string {
  return readFileSync(SYNC_SCRIPT, "utf8");
}

function parseBashArray(source: string, arrayName: string): string[] {
  const inlineEmpty = new RegExp(`^${arrayName}=\\(\\s*\\)`, "m");
  if (inlineEmpty.test(source)) {
    return [];
  }

  const pattern = new RegExp(`^${arrayName}=\\(\\s*([\\s\\S]*?)^\\)`, "m");
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find bash array ${arrayName} in sync-secrets.sh`);
  }

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parsePreflightKeys(source: string, service: SyncSecretsService): string[] {
  const pattern = new RegExp(
    `${service}\\)\\s*\\n\\s*keys=\\(\\s*([\\s\\S]*?)\\s*\\)`,
    "m",
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find preflight keys for service ${service}`);
  }

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function assertEqualSets(label: string, expected: readonly string[], actual: readonly string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  const missing = expected.filter((key) => !actualSet.has(key));
  const extra = actual.filter((key) => !expectedSet.has(key));

  if (missing.length > 0 || extra.length > 0) {
    const parts = [`${label} mismatch:`];
    if (missing.length > 0) {
      parts.push(`  missing in sync-secrets.sh: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`  extra in sync-secrets.sh: ${extra.join(", ")}`);
    }
    throw new Error(parts.join("\n"));
  }
}

function main(): void {
  const source = readSyncScript();

  const apiFlyKeys = parseBashArray(source, "API_FLY_KEYS");
  const webWranglerKeys = parseBashArray(source, "WEB_WRANGLER_KEYS");
  const marketingWranglerKeys = parseBashArray(source, "MARKETING_WRANGLER_KEYS");

  assertEqualSets(
    "api runtime Fly keys",
    SYNC_SECRETS_MANIFEST.services.api.runtimeKeys,
    apiFlyKeys,
  );
  assertEqualSets(
    "web runtime Wrangler keys",
    SYNC_SECRETS_MANIFEST.services.web.runtimeKeys,
    webWranglerKeys,
  );
  assertEqualSets(
    "marketing runtime Wrangler keys",
    SYNC_SECRETS_MANIFEST.services.marketing.runtimeKeys,
    marketingWranglerKeys,
  );

  for (const service of ["api", "web", "marketing"] as const) {
    assertEqualSets(
      `${service} preflight required GHA keys`,
      SYNC_SECRETS_MANIFEST.services[service].requiredGhaKeys,
      parsePreflightKeys(source, service),
    );
  }

  console.log("validate-sync-secrets-manifest: PASS");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`validate-sync-secrets-manifest: FAIL\n${message}`);
  process.exit(1);
}
