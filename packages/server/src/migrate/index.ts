import { migrate, type MigrateResult, type MigrationChain } from "@slugbase/db";
import { PGBOSS_SCHEMA, installPgBoss } from "./pgboss.ts";

export { OwnerConnectionError, assertApplicationRole } from "./role-guard.ts";
export type { ApplicationRoleCheck } from "./role-guard.ts";

export interface MigrationRunOptions {
  /** Connection URL of the migrator role (`DATABASE_MIGRATE_URL`). */
  readonly url: string;
  /** Migration sets applied after the CE chain and the pg-boss schema, in order. */
  readonly chains?: readonly MigrationChain[];
}

/**
 * The migration of doc 05 section 5.5, which the `migrate` command and the
 * server's `MIGRATE_ON_START` both run: the CE chain, then the pg-boss schema,
 * then the additional chains. It stops at the first failure and leaves what
 * the steps before it recorded. Every failure is a `MigrationError` that names
 * neither the connection string nor the password.
 */
export async function runMigrations(options: MigrationRunOptions): Promise<MigrateResult> {
  const { url, chains = [] } = options;
  const applied: MigrateResult["applied"] = [];
  applied.push(...(await migrate({ url })).applied);
  const installed = await installPgBoss(url);
  if (installed !== undefined) {
    applied.push({ chain: PGBOSS_SCHEMA, tag: `schema_${String(installed)}` });
  }
  if (chains.length > 0) {
    applied.push(...(await migrate({ url, chains })).applied);
  }
  return { applied };
}
