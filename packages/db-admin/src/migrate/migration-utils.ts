import { readMigrationFiles } from "drizzle-orm/migrator";

export function listMigrationHashes(migrationsFolder: string): string[] {
  return readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash);
}
