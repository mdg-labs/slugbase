import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDbClient } from "../dialect/create-client.js";
import { assertPostgresDatabaseUrl } from "../dialect/dialect.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  assertPostgresDatabaseUrl(databaseUrl);

  const migrationsFolder = path.join(packageRoot, "migrations");
  const { client, close } = createDbClient(databaseUrl);

  try {
    await migrate(client, { migrationsFolder });
  } finally {
    await close();
  }
}

export function getMigrationsFolder(): string {
  return path.join(packageRoot, "migrations");
}
