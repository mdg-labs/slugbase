import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient } from "../src/db/dialect/create-client.js";
import { InstanceMetadataRepository } from "../src/db/instance-metadata.repository.js";
import { getMigrationsFolder, runMigrations } from "../src/db/migrate/run-migrations.js";

describe("database migrations and repository (integration)", () => {
  let tempDir: string;
  let databaseUrl: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "slugbase-db-"));
    const dbPath = join(tempDir, "test.sqlite");
    databaseUrl = `sqlite://${dbPath}`;
    runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies forward migrations and records them in the bookkeeping table", () => {
    const dbPath = databaseUrl.slice("sqlite://".length);
    const native = new Database(dbPath);
    const migrationRows = native
      .prepare("SELECT id, hash FROM __drizzle_migrations")
      .all() as Array<{ id: number; hash: string }>;
    native.close();

    expect(migrationRows.length).toBeGreaterThan(0);
    expect(migrationRows[0]?.hash).toBeTruthy();
    expect(getMigrationsFolder()).toContain("migrations");
  });

  it("creates instance_metadata and round-trips through the repository", async () => {
    const { client, close } = createDbClient(databaseUrl);
    const repository = new InstanceMetadataRepository(client);

    await repository.set("setup.completed", "false");
    await expect(repository.get("setup.completed")).resolves.toBe("false");

    await repository.set("setup.completed", "true");
    await expect(repository.get("setup.completed")).resolves.toBe("true");
    await expect(repository.get("missing.key")).resolves.toBeNull();

    close();
  });
});
