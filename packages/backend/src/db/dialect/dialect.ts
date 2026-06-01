export function assertPostgresDatabaseUrl(databaseUrl: string): void {
  const normalized = databaseUrl.trim().toLowerCase();

  if (
    normalized.startsWith("sqlite:") ||
    normalized.startsWith("file:")
  ) {
    throw new Error(
      "SQLite support is deferred; use a postgresql:// or postgres:// DATABASE_URL",
    );
  }

  if (
    normalized.startsWith("postgres://") ||
    normalized.startsWith("postgresql://")
  ) {
    return;
  }

  throw new Error(
    "Unsupported DATABASE_URL scheme — expected postgres:// or postgresql://",
  );
}
