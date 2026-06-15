import postgres from "postgres";

export interface TestDatabaseHandle {
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

/** Clears application rows so a later setup suite can run on an empty instance. */
export async function resetAppData(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    if (tables.length === 0) {
      return;
    }
    const tableList = tables.map((row) => `"${row.tablename}"`).join(", ");
    await sql.unsafe(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  await Promise.resolve();

  const configured = process.env.DATABASE_URL?.trim();

  if (!configured) {
    throw new Error(
      "DATABASE_URL is required for integration tests. " +
        "Run pnpm test:integration (starts ephemeral Postgres locally) " +
        "or export DATABASE_URL=postgresql://…",
    );
  }

  const normalized = configured.toLowerCase();
  if (
    !normalized.startsWith("postgres://") &&
    !normalized.startsWith("postgresql://")
  ) {
    throw new Error(
      "Integration tests require a postgresql:// DATABASE_URL (SQLite support is deferred)",
    );
  }

  return {
    databaseUrl: configured,
    cleanup: async () => {},
  };
}
