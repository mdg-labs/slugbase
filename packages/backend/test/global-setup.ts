import { runMigrations } from "../src/db/migrate/run-migrations.js";

export default async function globalSetup(): Promise<void> {
  if (process.env.SLUGBASE_INTEGRATION_NO_DOCKER === "1") {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return;
  }

  await runMigrations(databaseUrl);
}
