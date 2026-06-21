import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function getMigrationsFolder(): string {
  return path.join(packageRoot, "migrations");
}

export function assertPostgresDatabaseUrl(databaseUrl: string): void {
  const normalized = databaseUrl.trim().toLowerCase();
  if (
    !normalized.startsWith("postgres://") &&
    !normalized.startsWith("postgresql://")
  ) {
    throw new Error("DATABASE_URL must use a postgresql:// scheme");
  }
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  assertPostgresDatabaseUrl(databaseUrl);

  const migrationsFolder = getMigrationsFolder();
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    await sql`CREATE SCHEMA IF NOT EXISTS admin`;
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
