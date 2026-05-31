import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";

import { createDbClient, type PostgresDrizzleClient, type SqliteDrizzleClient } from "../dialect/create-client.js";
import { resolveDialect } from "../dialect/dialect.js";
import {
  cleanupPostgresMigrationsFolder,
  preparePostgresMigrationsFolder,
} from "./postgres-migrations.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const dialect = resolveDialect(databaseUrl);
  const migrationsFolder = path.join(packageRoot, "migrations");

  if (dialect === "sqlite") {
    const { client, close } = createDbClient(databaseUrl);
    migrateSqlite(client as SqliteDrizzleClient, { migrationsFolder });
    await close();
    return;
  }

  const adaptedFolder = await preparePostgresMigrationsFolder(migrationsFolder);

  try {
    const { client, close } = createDbClient(databaseUrl);
    await migratePostgres(client as PostgresDrizzleClient, {
      migrationsFolder: adaptedFolder,
    });
    await close();
  } finally {
    await cleanupPostgresMigrationsFolder(adaptedFolder);
  }
}

export function getMigrationsFolder(): string {
  return path.join(packageRoot, "migrations");
}
