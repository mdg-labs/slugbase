import { createRequire } from "node:module";
import { MigrationError } from "@slugbase/db";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { connectionSecrets, redact } from "./secrets.ts";

// The pg-boss chain of doc 05 section 5.5: second after the CE chain, recorded
// in pg-boss's own version table. `migrate` installs it as `slugbase_owner`, so
// that the default privileges of the declarative SQL give `slugbase_app`, the
// role the worker connects as, its rights on what pg-boss creates; the worker
// itself never installs or upgrades it.

/** Where pg-boss keeps its tables; the worker's pg-boss uses the same schema. */
export const PGBOSS_SCHEMA = "pgboss";

const OWNER_ROLE = "slugbase_owner";
const STATEMENT_TIMEOUT = "15min";

/** pg-boss's own message for a statement that finds its object already installed, as it handles an install another process finished first. */
const ALREADY_INSTALLED = "already exists";

interface Pool {
  open(): Promise<void>;
  close(): Promise<void>;
}

function isPool(value: unknown): value is Pool {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { open?: unknown }).open === "function" &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

/** The schema version this build of pg-boss installs. */
function expectedVersion(): number {
  const manifest = createRequire(import.meta.url)("pg-boss/package.json") as { pgboss?: { schema?: unknown } };
  const version = manifest.pgboss?.schema;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new MigrationError("the installed pg-boss does not declare the version of its schema");
  }
  return version;
}

// The session starts as the owner role, which the migrator may act as, and is
// bounded by statement_timeout. lock_timeout stays off: a second `migrate`
// waits on pg-boss's advisory lock while the first one installs.
function ownerSessionUrl(url: string): string {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("options");
  const ours = `-c role=${OWNER_ROLE} -c statement_timeout=${STATEMENT_TIMEOUT}`;
  parsed.searchParams.set("options", existing === null || existing === "" ? ours : `${existing} ${ours}`);
  return parsed.href;
}

/**
 * Installs the pg-boss schema when the database has none, as `slugbase_owner`
 * over `url` (`DATABASE_MIGRATE_URL`), and checks that the schema is at the
 * version this build installs. Returns that version when this call installed
 * it, and undefined when it was already there, also when another `migrate`
 * installed it first. A schema at any other version rejects: upgrading one is
 * not something `migrate` does yet.
 */
export async function installPgBoss(url: string): Promise<number | undefined> {
  const secrets = connectionSecrets(url);
  try {
    const expected = expectedVersion();
    const boss = new PgBoss({
      connectionString: ownerSessionUrl(url),
      schema: PGBOSS_SCHEMA,
      max: 1,
      application_name: "slugbase-migrate-pgboss",
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    // A failed statement rejects its own call; this only keeps the pool's errors on an idle connection from ending the process.
    boss.on("error", () => undefined);
    const pool: unknown = boss.getDb();
    if (!isPool(pool)) {
      throw new MigrationError("the installed pg-boss does not expose its connection pool");
    }
    await pool.open();
    try {
      let installed = false;
      if (!(await boss.isInstalled())) {
        try {
          await boss.getDb().executeSql(getConstructionPlans(PGBOSS_SCHEMA, { createSchema: false }));
          installed = true;
        } catch (error) {
          // The plan runs in one transaction and failed part-way through it.
          await boss.getDb().executeSql("ROLLBACK");
          if (!(error instanceof Error) || !error.message.includes(ALREADY_INSTALLED)) {
            throw error;
          }
        }
      }
      const version = await boss.schemaVersion();
      if (version !== expected) {
        throw new MigrationError(
          `the pg-boss schema is at version ${version === null ? "none" : String(version)}, and this build installs and runs version ${String(expected)}`,
        );
      }
      return installed ? expected : undefined;
    } finally {
      await pool.close();
    }
  } catch (error) {
    if (error instanceof MigrationError) {
      throw new MigrationError(redact(error.message, secrets), error.code);
    }
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error && error.message !== "" ? error.message : "unknown error";
    throw new MigrationError(
      redact(`the pg-boss schema could not be installed: ${message}`, secrets),
      typeof code === "string" ? redact(code, secrets) : undefined,
    );
  }
}
