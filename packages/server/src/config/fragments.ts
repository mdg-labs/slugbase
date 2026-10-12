import { z } from "zod";
import {
  DEVELOPMENT_APP_ORIGIN,
  DEVELOPMENT_DATABASE_MIGRATE_URL,
  DEVELOPMENT_DATABASE_PASSWORDS,
  DEVELOPMENT_DATABASE_URL,
  DEVELOPMENT_ENCRYPTION_KEY,
  DEVELOPMENT_ENCRYPTION_KEY_ID,
  DEVELOPMENT_SESSION_SECRET,
} from "./development-defaults.ts";
import { envBoolean } from "./env-boolean.ts";
import { base64Key, baseUrl, envInteger, optional, originUrl, postgresUrl } from "./fields.ts";
import { envFragment, type RefineContext } from "./fragment.ts";

export const NODE_ENVS = ["development", "test", "production"] as const;
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export const MIN_SESSION_SECRET_LENGTH = 32;

export const DEFAULT_DOCS_BASE_URL = "https://slugbase.app/docs";

/** Every process: the environment and the log level. */
export const runtimeFragment = envFragment({
  shape: {
    NODE_ENV: z.enum(NODE_ENVS, { error: `must be one of ${NODE_ENVS.join(", ")}` }),
    LOG_LEVEL: z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(", ")}` }).default("info"),
  },
});

/** The deployment origin, for the server and the worker (links in mail, cookie names, HSTS). */
export const originFragment = envFragment({
  shape: { APP_ORIGIN: originUrl() },
  developmentDefaults: { APP_ORIGIN: DEVELOPMENT_APP_ORIGIN },
  refine(values, context) {
    if (context.production && !values.APP_ORIGIN.startsWith("https://")) {
      context.issue("APP_ORIGIN", "must be an https origin in production");
    }
  },
});

/** The session secret and the secret-box key (Q13), for the server and the worker. */
export const secretsFragment = envFragment({
  shape: {
    SESSION_SECRET: z.string().refine((value) => value !== "", { error: "is required" }),
    ENCRYPTION_KEY: base64Key(32),
    ENCRYPTION_KEY_ID: z.string().refine((value) => /^[A-Za-z0-9._-]{1,64}$/.test(value), {
      error: "must be 1 to 64 letters, digits, dots, hyphens or underscores",
    }),
  },
  developmentDefaults: {
    SESSION_SECRET: DEVELOPMENT_SESSION_SECRET,
    ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
    ENCRYPTION_KEY_ID: DEVELOPMENT_ENCRYPTION_KEY_ID,
  },
  refine(values, context) {
    if (context.production && values.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
      context.issue("SESSION_SECRET", `must be at least ${String(MIN_SESSION_SECRET_LENGTH)} characters in production`);
    }
  },
});

function refuseDevelopmentCredential(key: string, url: string | undefined, context: RefineContext): void {
  if (context.production && url !== undefined && DEVELOPMENT_DATABASE_PASSWORDS.has(decodePassword(url))) {
    context.issue(key, "must not use a development database password in production");
  }
}

function decodePassword(url: string): string {
  const { password } = new URL(url);
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

/** The application role's connection, for the server and the worker (Q56). */
export const databaseFragment = envFragment({
  shape: {
    DATABASE_URL: postgresUrl(),
    SLUGBASE_ALLOW_OWNER_CONNECTION: envBoolean().default(false),
  },
  developmentDefaults: { DATABASE_URL: DEVELOPMENT_DATABASE_URL },
  refine(values, context) {
    refuseDevelopmentCredential("DATABASE_URL", values.DATABASE_URL, context);
  },
});

/** The server's in-process migration (D25): needs the migrator URL unless a deploy step migrates. */
export const serverMigrationFragment = envFragment({
  shape: {
    MIGRATE_ON_START: envBoolean().default(true),
    DATABASE_MIGRATE_URL: optional(postgresUrl()),
  },
  developmentDefaults: { DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL },
  refine(values, context) {
    if (values.MIGRATE_ON_START && values.DATABASE_MIGRATE_URL === undefined) {
      context.issue("DATABASE_MIGRATE_URL", "is required while MIGRATE_ON_START is true; set it or set MIGRATE_ON_START=false");
    }
    refuseDevelopmentCredential("DATABASE_MIGRATE_URL", values.DATABASE_MIGRATE_URL, context);
  },
});

/** The `migrate` command: the migrator role's connection only. */
export const migrateFragment = envFragment({
  shape: { DATABASE_MIGRATE_URL: postgresUrl() },
  developmentDefaults: { DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL },
  refine(values, context) {
    refuseDevelopmentCredential("DATABASE_MIGRATE_URL", values.DATABASE_MIGRATE_URL, context);
  },
});

/** The public listener and the HTTP behaviour of the server. */
export const httpFragment = envFragment({
  shape: {
    PORT: envInteger({ min: 1, max: 65535 }).default(3000),
    TRUSTED_PROXY_HOPS: envInteger({ min: 0, max: 32 }).default(0),
    API_DOCS_ENABLED: envBoolean().default(true),
    DOCS_BASE_URL: baseUrl().default(DEFAULT_DOCS_BASE_URL),
  },
});

/**
 * The internal listener for `/metrics` (doc 01 section 12), for the server and
 * the worker. Unset means there is none: nothing exposes metrics by default (D27).
 */
export const metricsFragment = envFragment({
  shape: { METRICS_PORT: optional(envInteger({ min: 1, max: 65535 })) },
});
