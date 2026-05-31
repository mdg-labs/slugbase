export type DbDialect = "sqlite" | "postgres";

export function resolveDialect(databaseUrl: string): DbDialect {
  const normalized = databaseUrl.trim().toLowerCase();

  if (
    normalized.startsWith("sqlite:") ||
    normalized.startsWith("file:")
  ) {
    return "sqlite";
  }

  if (
    normalized.startsWith("postgres://") ||
    normalized.startsWith("postgresql://")
  ) {
    return "postgres";
  }

  throw new Error(
    `Unsupported DATABASE_URL scheme — expected sqlite:, file:, postgres:, or postgresql:`,
  );
}

export function parseSqliteFilePath(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    const remainder = databaseUrl.slice("file:".length);
    if (remainder.startsWith("./") || remainder.startsWith("../")) {
      return remainder;
    }
    if (remainder.startsWith("/")) {
      return decodeURIComponent(remainder);
    }
    return remainder;
  }

  if (!databaseUrl.startsWith("sqlite:")) {
    throw new Error(`Expected sqlite DATABASE_URL, received a non-sqlite URL`);
  }

  const remainder = databaseUrl.slice("sqlite:".length);

  if (remainder.startsWith("//")) {
    const withoutSlashes = remainder.slice(2);
    if (withoutSlashes.startsWith("./") || withoutSlashes.startsWith("../")) {
      return withoutSlashes;
    }

    if (withoutSlashes.startsWith("/")) {
      return withoutSlashes;
    }

    return `./${withoutSlashes}`;
  }

  return remainder;
}
