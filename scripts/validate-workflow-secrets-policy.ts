import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SYNC_SECRETS_MANIFEST,
  workflowSecretKeys,
} from "./sync-secrets-manifest.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW_FILE = resolve(REPO_ROOT, ".github/workflows/sync-secrets.yml");

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function parseWorkflowSecretKeys(workflowYaml: string): string[] {
  const keys = new Set<string>();
  const pattern = /^\s+([A-Z][A-Z0-9_]*):\s+\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/gm;

  for (const match of workflowYaml.matchAll(pattern)) {
    const envName = match[1];
    const secretName = match[2];
    if (envName !== secretName) {
      throw new Error(
        `sync-secrets.yml maps env ${envName} from secrets.${secretName} — names must match`,
      );
    }
    keys.add(secretName);
  }

  return [...keys].sort();
}

function assertEqualSets(label: string, expected: readonly string[], actual: readonly string[]): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  const missing = expected.filter((key) => !actualSet.has(key));
  const extra = actual.filter((key) => !expectedSet.has(key));

  if (missing.length > 0 || extra.length > 0) {
    const parts = [`${label} mismatch:`];
    if (missing.length > 0) {
      parts.push(`  missing: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`  extra: ${extra.join(", ")}`);
    }
    throw new Error(parts.join("\n"));
  }
}

function main(): void {
  const workflowYaml = readFile(WORKFLOW_FILE);

  const expectedWorkflowKeys = workflowSecretKeys(SYNC_SECRETS_MANIFEST);
  const workflowKeys = parseWorkflowSecretKeys(workflowYaml);

  assertEqualSets(
    "sync-secrets.yml secrets.* env mappings",
    expectedWorkflowKeys,
    workflowKeys,
  );

  const scriptStorageKeys = new Set<string>([
    ...SYNC_SECRETS_MANIFEST.platformGhaKeys,
    "NODE_ENV",
    "SENTRY_DSN_API",
    "SENTRY_DSN_ADMIN",
    ...SYNC_SECRETS_MANIFEST.services.api.requiredGhaKeys,
    ...SYNC_SECRETS_MANIFEST.services.web.requiredGhaKeys,
    ...SYNC_SECRETS_MANIFEST.services.marketing.requiredGhaKeys,
    ...SYNC_SECRETS_MANIFEST.services.admin.requiredGhaKeys,
  ]);

  for (const runtimeKey of SYNC_SECRETS_MANIFEST.services.api.runtimeKeys) {
    const storageKey =
      Object.entries(SYNC_SECRETS_MANIFEST.storageToRuntimeAliases).find(
        ([, runtime]) => runtime === runtimeKey,
      )?.[0] ?? runtimeKey;
    scriptStorageKeys.add(storageKey);
  }

  for (const runtimeKey of SYNC_SECRETS_MANIFEST.services.admin.runtimeKeys) {
    const storageKey =
      Object.entries(SYNC_SECRETS_MANIFEST.storageToRuntimeAliases).find(
        ([, runtime]) => runtime === runtimeKey,
      )?.[0] ?? runtimeKey;
    scriptStorageKeys.add(storageKey);
  }

  for (const runtimeKey of SYNC_SECRETS_MANIFEST.services.web.runtimeKeys) {
    scriptStorageKeys.add(runtimeKey);
  }

  const workflowKeySet = new Set(workflowKeys);
  const missingInWorkflow = [...scriptStorageKeys].filter((key) => !workflowKeySet.has(key));
  if (missingInWorkflow.length > 0) {
    throw new Error(
      `sync-secrets.sh references GHA keys missing from sync-secrets.yml: ${missingInWorkflow.join(", ")}`,
    );
  }

  console.log("validate-workflow-secrets-policy: PASS");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`validate-workflow-secrets-policy: FAIL\n${message}`);
  process.exit(1);
}
