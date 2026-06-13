export interface TestDatabaseHandle {
  databaseUrl: string;
  cleanup: () => Promise<void>;
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
