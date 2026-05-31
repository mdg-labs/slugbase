import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { createDbClient } from "../dialect/create-client.js";
import { resolveDialect } from "../dialect/dialect.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function runMigrations(databaseUrl: string): void {
  const dialect = resolveDialect(databaseUrl);
  const migrationsFolder = path.join(packageRoot, "migrations");

  if (dialect === "sqlite") {
    const { client, close } = createDbClient(databaseUrl);
    migrate(client, { migrationsFolder });
    close();
    return;
  }

  throw new Error(
    "Postgres migrations are not wired in this release slice — use sqlite DATABASE_URL",
  );
}

export function getMigrationsFolder(): string {
  return path.join(packageRoot, "migrations");
}
