import type { z } from "zod";
import { composeEnvSchema } from "./fragment.ts";
import {
  databaseFragment,
  errorReportFragment,
  httpFragment,
  metricsFragment,
  mfaFragment,
  migrateFragment,
  originFragment,
  passwordPolicyFragment,
  runtimeFragment,
  secretsFragment,
  serverMigrationFragment,
  setupFragment,
  smtpFragment,
} from "./fragments.ts";
import { rateLimitFragment } from "./rate-limits.ts";

export const PROCESS_TYPES = ["server", "worker", "migrate"] as const;

export type ProcessType = (typeof PROCESS_TYPES)[number];

export function isProcessType(value: string): value is ProcessType {
  return (PROCESS_TYPES as readonly string[]).includes(value);
}

/** The fragments of each process type (doc 01 section 3). A module adds its own to extend one. */
export const serverFragments = [
  runtimeFragment,
  originFragment,
  secretsFragment,
  databaseFragment,
  serverMigrationFragment,
  httpFragment,
  setupFragment,
  passwordPolicyFragment,
  mfaFragment,
  rateLimitFragment,
  metricsFragment,
  errorReportFragment,
  smtpFragment,
] as const;

/** The worker never receives the migrator URL (doc 01 section 2.1). */
export const workerFragments = [
  runtimeFragment,
  originFragment,
  secretsFragment,
  databaseFragment,
  rateLimitFragment,
  metricsFragment,
  errorReportFragment,
  smtpFragment,
] as const;

export const migrateFragments = [runtimeFragment, migrateFragment] as const;

export const serverEnvSchema = composeEnvSchema(serverFragments);
export const workerEnvSchema = composeEnvSchema(workerFragments);
export const migrateEnvSchema = composeEnvSchema(migrateFragments);

export type ServerConfig = z.infer<typeof serverEnvSchema.object>;
export type WorkerConfig = z.infer<typeof workerEnvSchema.object>;
export type MigrateConfig = z.infer<typeof migrateEnvSchema.object>;

export interface ConfigByProcess {
  server: ServerConfig;
  worker: WorkerConfig;
  migrate: MigrateConfig;
}

export const envSchemas = {
  server: serverEnvSchema,
  worker: workerEnvSchema,
  migrate: migrateEnvSchema,
} as const;

/** Every key any process type declares: the key inventory `.env.example` is checked against. */
export function declaredKeys(): readonly string[] {
  return [...new Set(PROCESS_TYPES.flatMap((type) => envSchemas[type].keys))].sort();
}
