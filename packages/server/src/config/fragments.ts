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
import {
  KEY_ID_PATTERN,
  base64Key,
  baseUrl,
  envInteger,
  mailbox,
  optional,
  originUrl,
  postgresUrl,
  previousKeys,
  relayHost,
  sentryDsn,
} from "./fields.ts";
import { envFragment, requireAllOrNone, type RefineContext } from "./fragment.ts";

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

/**
 * The session secret and the secret-box keys (Q13), for the server and the worker. The previous keys
 * only open values sealed before a rotation; the current key seals.
 */
export const secretsFragment = envFragment({
  shape: {
    SESSION_SECRET: z.string().refine((value) => value !== "", { error: "is required" }),
    ENCRYPTION_KEY: base64Key(32),
    ENCRYPTION_KEY_ID: z.string().refine((value) => KEY_ID_PATTERN.test(value), {
      error: "must be 1 to 64 letters, digits, dots, hyphens or underscores",
    }),
    ENCRYPTION_KEY_PREVIOUS: previousKeys(32),
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
    const ids = [values.ENCRYPTION_KEY_ID, ...values.ENCRYPTION_KEY_PREVIOUS.map((previous) => previous.keyId)];
    if (new Set(ids).size !== ids.length) {
      context.issue("ENCRYPTION_KEY_PREVIOUS", "must not repeat a key id or use the id of ENCRYPTION_KEY_ID");
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

/**
 * The error-report destination (doc 01 sections 6 and 11), for the server and the worker. Unset
 * selects the no-op adapter, which reports nothing beyond the log.
 */
export const errorReportFragment = envFragment({
  shape: { ERROR_REPORT_DSN: optional(sentryDsn()) },
});

export const SMTP_SECURITIES = ["tls", "starttls", "none"] as const;

/** The relay and the sender: required together as soon as any SMTP key is set. */
export const SMTP_REQUIRED_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_FROM"] as const;

/** The relay's credentials: an optional pair, so an authless relay needs neither. */
export const SMTP_CREDENTIAL_KEYS = ["SMTP_USER", "SMTP_PASS"] as const;

export const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;

/**
 * The SMTP relay of the mail adapter (doc 01 sections 6 and 11), for the server and the worker. All
 * six keys unset selects the log-only adapter. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_FROM`
 * are required together; `SMTP_USER` and `SMTP_PASS` are an optional pair, both or neither, and neither
 * is set without the other four. A violation refuses to start and names the missing keys.
 */
export const smtpFragment = envFragment({
  shape: {
    SMTP_HOST: optional(relayHost()),
    SMTP_PORT: optional(envInteger({ min: 1, max: 65535 })),
    SMTP_SECURITY: optional(z.enum(SMTP_SECURITIES, { error: `must be one of ${SMTP_SECURITIES.join(", ")}` })),
    SMTP_USER: optional(z.string()),
    SMTP_PASS: optional(z.string()),
    SMTP_FROM: optional(mailbox()),
  },
  refine(values, context) {
    requireAllOrNone(SMTP_CREDENTIAL_KEYS, values, context);
    const set = SMTP_KEYS.filter((key) => values[key] !== undefined);
    if (set.length === 0) {
      return;
    }
    for (const key of SMTP_REQUIRED_KEYS.filter((candidate) => values[candidate] === undefined)) {
      context.issue(key, `is required because ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set`);
    }
  },
});
