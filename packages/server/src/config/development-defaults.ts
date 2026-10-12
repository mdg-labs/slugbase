// The development values of `.env.example` that production refuses (doc 01
// section 11). They match compose.dev.yml (doc 08 section 1.3). A test keeps
// this table and `.env.example` equal.

export const DEVELOPMENT_APP_ORIGIN = "http://localhost:5173";

export const DEVELOPMENT_DATABASE_URL = "postgres://slugbase_app:slugbase_app_dev_only@localhost:54329/slugbase_dev";

export const DEVELOPMENT_DATABASE_MIGRATE_URL =
  "postgres://slugbase_migrator:slugbase_migrator_dev_only@localhost:54329/slugbase_dev";

export const DEVELOPMENT_SESSION_SECRET = "development-session-secret-not-for-production-use";

// Base64 of 32 bytes; `pnpm dev:env` replaces it with a generated key.
export const DEVELOPMENT_ENCRYPTION_KEY = "ZGV2ZWxvcG1lbnQtZW5jcnlwdGlvbi1rZXktMDAwMDA=";

export const DEVELOPMENT_ENCRYPTION_KEY_ID = "dev-1";

// The passwords compose.dev.yml gives the application roles. A database URL
// carrying one is a development credential whatever its host.
export const DEVELOPMENT_DATABASE_PASSWORDS: ReadonlySet<string> = new Set([
  "slugbase_app_dev_only",
  "slugbase_migrator_dev_only",
]);
