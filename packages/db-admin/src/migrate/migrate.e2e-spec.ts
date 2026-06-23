import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  ADMIN_MIGRATIONS_SCHEMA,
  ADMIN_MIGRATIONS_TABLE,
} from "../migrate/migration-bookkeeping.js";
import { listMigrationHashes } from "../migrate/migration-utils.js";
import {
  getMigrationsFolder,
  runMigrations,
} from "../migrate/run-migrations.js";

const packageSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("db-admin migrations (integration)", () => {
  it("applies forward migrations and records them in drizzle bookkeeping", async () => {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    await runMigrations(databaseUrl);

    const expectedHashes = listMigrationHashes(getMigrationsFolder());
    expect(expectedHashes.length).toBeGreaterThan(0);

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const migrationRows = await sql<
        Array<{ id: number; hash: string }>
      >`SELECT id, hash FROM ${sql(ADMIN_MIGRATIONS_SCHEMA)}.${sql(ADMIN_MIGRATIONS_TABLE)} ORDER BY id`;
      const appliedHashes = new Set(migrationRows.map((row) => row.hash));
      for (const hash of expectedHashes) {
        expect(appliedHashes.has(hash)).toBe(true);
      }

      const adminTables = await sql<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'admin' ORDER BY tablename
      `;
      expect(adminTables.map((row) => row.tablename)).toEqual([
        "admin_invites",
        "admin_sessions",
        "admin_users",
        "audit_events",
        "daily_snapshots",
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe("public-read mutation guard", () => {
  it("does not define INSERT/UPDATE/DELETE against public.* in package sources", async () => {
    const srcRoot = packageSrc;
    const forbidden = /\b(INSERT|UPDATE|DELETE)\b[\s\S]*?\bpublic\./i;
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "test") {
            continue;
          }
          await walk(fullPath);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".spec.ts") &&
          !entry.name.endsWith(".e2e-spec.ts")
        ) {
          files.push(fullPath);
        }
      }
    }

    await walk(srcRoot);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).not.toMatch(forbidden);
    }
  });
});
