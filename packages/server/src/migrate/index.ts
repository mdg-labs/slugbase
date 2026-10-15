import { migrate, type MigrateResult, type MigrationChain } from "@slugbase/db";
import { builtInJobs } from "../worker/built-in.ts";
import type { JobDefinition } from "../worker/job.ts";
import { PGBOSS_SCHEMA, installPgBoss } from "./pgboss.ts";

export { OwnerConnectionError, assertApplicationRole } from "./role-guard.ts";
export type { ApplicationRoleCheck } from "./role-guard.ts";

export interface MigrationRunOptions {
  /** Connection URL of the migrator role (`DATABASE_MIGRATE_URL`). */
  readonly url: string;
  /** Migration sets applied after the CE chain and the pg-boss schema, in order. */
  readonly chains?: readonly MigrationChain[];
  /**
   * The jobs the modules of the deployment register, beside the built-in ones, whose queues are created
   * with the settings the worker applies. Pass the jobs of the modules the worker composes.
   */
  readonly jobs?: readonly JobDefinition[];
}

/**
 * The migration of doc 05 section 5.5, which the `migrate` command and the
 * server's `MIGRATE_ON_START` both run: the CE chain, then the pg-boss schema
 * (installed, or upgraded to the version this build runs, and the queue of every
 * job created), then the additional chains. It stops at the first failure and
 * leaves what the steps before it recorded. Every failure is a `MigrationError`
 * that names neither the connection string nor the password.
 */
export async function runMigrations(options: MigrationRunOptions): Promise<MigrateResult> {
  const { url, chains = [], jobs = [] } = options;
  const applied: MigrateResult["applied"] = [];
  applied.push(...(await migrate({ url })).applied);
  const version = await installPgBoss(url, [...builtInJobs(), ...jobs]);
  if (version !== undefined) {
    applied.push({ chain: PGBOSS_SCHEMA, tag: `schema_${String(version)}` });
  }
  if (chains.length > 0) {
    applied.push(...(await migrate({ url, chains })).applied);
  }
  return { applied };
}
