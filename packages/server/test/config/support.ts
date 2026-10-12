import { randomBytes } from "node:crypto";

/** A production-grade environment for a process type: every value passes the refusals. */
export function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    APP_ORIGIN: "https://bookmarks.example.com",
    DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
    DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY_ID: "k1",
    ...overrides,
  };
}

/** The keys and values of an env file: `KEY=value` lines, comments and blanks skipped. */
export function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      entries.set(match[1], match[2] ?? "");
    }
  }
  return entries;
}
