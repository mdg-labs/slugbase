import Database from "better-sqlite3";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient } from "../src/db/dialect/create-client.js";
import { resolveDialect } from "../src/db/dialect/dialect.js";
import { InstanceMetadataRepository } from "../src/db/instance-metadata.repository.js";
import { listMigrationHashes } from "../src/db/migrate/postgres-migrations.js";
import { getMigrationsFolder, runMigrations } from "../src/db/migrate/run-migrations.js";
import { createTestDatabase } from "./test-database.js";

describe("database migrations and repository (integration)", () => {
  let databaseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    databaseUrl = testDatabase.databaseUrl;
    cleanup = testDatabase.cleanup;
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("applies forward migrations and records them in the bookkeeping table", async () => {
    const expectedHashes = listMigrationHashes(getMigrationsFolder());
    expect(expectedHashes.length).toBeGreaterThan(0);
    expect(getMigrationsFolder()).toContain("migrations");

    if (resolveDialect(databaseUrl) === "sqlite") {
      const dbPath = databaseUrl.slice("sqlite://".length);
      const native = new Database(dbPath);
      const migrationRows = native
        .prepare("SELECT id, hash FROM __drizzle_migrations")
        .all() as Array<{ id: number; hash: string }>;
      native.close();

      expect(migrationRows.length).toBe(expectedHashes.length);
      expect(migrationRows[0]?.hash).toBeTruthy();
      return;
    }

    const sql = postgres(databaseUrl, { max: 1 });
    const migrationRows = await sql<
      Array<{ id: number; hash: string }>
    >`SELECT id, hash FROM drizzle.__drizzle_migrations`;
    await sql.end({ timeout: 5 });

    expect(migrationRows.length).toBe(expectedHashes.length);
    expect(migrationRows[0]?.hash).toBeTruthy();
  });

  it("creates instance_metadata and round-trips through the repository", async () => {
    const { client, dialect, close } = createDbClient(databaseUrl);
    const repository = new InstanceMetadataRepository(client, dialect);

    await repository.set("setup.completed", "false");
    await expect(repository.get("setup.completed")).resolves.toBe("false");

    await repository.set("setup.completed", "true");
    await expect(repository.get("setup.completed")).resolves.toBe("true");
    await expect(repository.get("missing.key")).resolves.toBeNull();

    await close();
  });
});
