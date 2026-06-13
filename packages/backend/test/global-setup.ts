import { runMigrations } from "../src/db/migrate/run-migrations.js";

export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return;
  }

  await runMigrations(databaseUrl);
}
