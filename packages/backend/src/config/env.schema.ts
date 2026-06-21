import { z } from "zod";

import type { SlugbaseEdition } from "@slugbase/shared-types";

import {
  oidcDeploymentProviderSchema,
  parseOidcDeploymentProviders,
  type OidcDeploymentProvider,
} from "./oidc-deployment-providers.js";

/** Parses env-style booleans; `z.coerce.boolean()` treats the string `"false"` as true. */
function parseEnvBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return Boolean(value);
}

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => parseEnvBoolean(value, defaultValue), z.boolean());

/** Optional string-env boolean: unset → `undefined`; `"false"` / `"true"` parse correctly. */
const optionalEnvBoolean = () =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    return parseEnvBoolean(value, true);
  }, z.boolean().optional());

const requiredSecretsSchema = z
  .object({
    SESSION_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string().min(32),
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
    APP_BASE_URL: z.string().url(),
    FRONTEND_ORIGIN: z.string().url(),
  })
  .strict();

const optionalFlagsSchema = z
  .object({
    PUBLIC_REGISTRATION: envBoolean(false),
    EMAIL_VERIFICATION_REQUIRED: envBoolean(false),
    PORT: z.coerce.number().int().positive().default(3000),
    SERVE_WEB_CLIENT: envBoolean(false),
    WEB_CLIENT_SERVER_BUILD: z.string().min(1).optional(),
    // SMTP transport (spec §11.1, §15) - optional; no-op mail used when SMTP_HOST is absent
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: envBoolean(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(1).optional(),
    // OpenAI AI suggestions (spec §11.2, §15) - optional; no-op AI used when absent
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
    // Stripe billing (spec §11.4, §15) - optional; no-op billing / full entitlements when absent
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Config-driven Stripe price ids (spec §12.1, def §6) - not hard-coded in app logic
    // Per-interval price IDs (spec §12.1, per-interval billing)
    STRIPE_PRICE_PERSONAL_MONTHLY: z.string().min(1).optional(),
    STRIPE_PRICE_PERSONAL_ANNUAL: z.string().min(1).optional(),
    STRIPE_PRICE_TEAM_MONTHLY: z.string().min(1).optional(),
    STRIPE_PRICE_TEAM_ANNUAL: z.string().min(1).optional(),
    STRIPE_PRICE_SUPPORTER: z.string().min(1).optional(),
    SUPPORTER_PROMOTION_END: z.string().min(1).optional(),
    // Downgrade overflow grace (spec §12.5, def §5) - days after period end before archive
    DOWNGRADE_GRACE_PERIOD_DAYS: z.coerce.number().int().nonnegative().default(7),
    // Session TTL (spec §5.3, def §3) - sliding window; default 30 days
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Extended session TTL when login remember-me is checked (spec §5.3)
    SESSION_REMEMBER_TTL_DAYS: z.coerce.number().int().positive().default(90),
    // MFA TOTP issuer label shown in authenticator apps (spec §5.7)
    MFA_TOTP_ISSUER: z.string().min(1).default("SlugBase"),
    // Rate limiting (spec §18, def §4) - IP-based for login/register/MFA; user-based for token creation
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_LOGIN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    RATE_LIMIT_TOKEN_CREATION_MAX: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // Signup + email-change verification sends (spec §5.5, §18) - per user, unused tokens in window
    RATE_LIMIT_EMAIL_VERIFICATION_MAX: z.coerce.number().int().positive().default(3),
    RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // Cloudflare Turnstile challenge (spec §11.8, §15) - optional; no-op challenge when absent
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    // Skip challenge verification in development (spec §11.8) - defaults true when NODE_ENV !== production
    CHALLENGE_DEV_SKIP: optionalEnvBoolean(),
    // Product analytics (spec §11.6, §15) - optional; no-op used when Umami is absent
    UMAMI_HOST: z.string().url().optional(),
    UMAMI_WEBSITE_ID: z.string().min(1).optional(),
    // Error reporting (spec §11.7, §15) - optional; no-op used when SENTRY_DSN is absent
    SENTRY_DSN: z.string().min(1).optional(),
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
    SENTRY_RELEASE: z.string().min(1).optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.string().min(1).optional(),
    SENTRY_PROFILING_SAMPLE_RATE: z.string().min(1).optional(),
    SENTRY_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
    SENTRY_ENABLE_CONSOLE_LOGGING: envBoolean(false),
    // OpenAPI interactive docs (spec §18) - optional Scalar UI at GET /docs
    OPENAPI_INTERACTIVE_DOCS: envBoolean(true),
    // Hosted OIDC providers (spec §11.3) - JSON array; unset = DB-sourced (self-host)
    OIDC_DEPLOYMENT_PROVIDERS: z.preprocess(
      (value) =>
        parseOidcDeploymentProviders(
          typeof value === "string" ? value : undefined,
        ),
      z.array(oidcDeploymentProviderSchema).optional(),
    ),
  })
  .strict()
  .superRefine((flags, ctx) => {
    if (flags.SERVE_WEB_CLIENT && !flags.WEB_CLIENT_SERVER_BUILD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "WEB_CLIENT_SERVER_BUILD is required when SERVE_WEB_CLIENT is enabled",
        path: ["WEB_CLIENT_SERVER_BUILD"],
      });
    }
  });

export type RequiredSecrets = z.infer<typeof requiredSecretsSchema>;
export type OptionalFlags = z.infer<typeof optionalFlagsSchema>;

export type { OidcDeploymentProvider };

export type AppConfig = RequiredSecrets &
  OptionalFlags & {
    nodeEnv: NodeEnv;
    isProduction: boolean;
    edition: SlugbaseEdition;
  };

export type NodeEnv = "development" | "test" | "production";

const nodeEnvSchema = z.enum(["development", "test", "production"]);

function parseNodeEnv(value: string | undefined): NodeEnv {
  const parsed = nodeEnvSchema.safeParse(value ?? "development");
  if (!parsed.success) {
    return "development";
  }
  return parsed.data;
}

function readSecretsInput(env: NodeJS.ProcessEnv) {
  return {
    SESSION_SECRET: env.SESSION_SECRET,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED,
    APP_BASE_URL: env.APP_BASE_URL,
    FRONTEND_ORIGIN: env.FRONTEND_ORIGIN,
  };
}

function readFlagsInput(env: NodeJS.ProcessEnv) {
  return {
    PUBLIC_REGISTRATION: env.PUBLIC_REGISTRATION,
    EMAIL_VERIFICATION_REQUIRED: env.EMAIL_VERIFICATION_REQUIRED,
    PORT: env.PORT,
    SERVE_WEB_CLIENT: env.SERVE_WEB_CLIENT,
    WEB_CLIENT_SERVER_BUILD: env.WEB_CLIENT_SERVER_BUILD,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: env.SMTP_SECURE,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    SMTP_FROM: env.SMTP_FROM,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_MODEL: env.OPENAI_MODEL,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_PERSONAL_MONTHLY: env.STRIPE_PRICE_PERSONAL_MONTHLY,
    STRIPE_PRICE_PERSONAL_ANNUAL: env.STRIPE_PRICE_PERSONAL_ANNUAL,
    STRIPE_PRICE_TEAM_MONTHLY: env.STRIPE_PRICE_TEAM_MONTHLY,
    STRIPE_PRICE_TEAM_ANNUAL: env.STRIPE_PRICE_TEAM_ANNUAL,
    STRIPE_PRICE_SUPPORTER: env.STRIPE_PRICE_SUPPORTER,
    SUPPORTER_PROMOTION_END: env.SUPPORTER_PROMOTION_END,
    DOWNGRADE_GRACE_PERIOD_DAYS: env.DOWNGRADE_GRACE_PERIOD_DAYS,
    SESSION_TTL_DAYS: env.SESSION_TTL_DAYS,
    SESSION_REMEMBER_TTL_DAYS: env.SESSION_REMEMBER_TTL_DAYS,
    MFA_TOTP_ISSUER: env.MFA_TOTP_ISSUER,
    RATE_LIMIT_LOGIN_MAX: env.RATE_LIMIT_LOGIN_MAX,
    RATE_LIMIT_LOGIN_TTL_SECONDS: env.RATE_LIMIT_LOGIN_TTL_SECONDS,
    RATE_LIMIT_TOKEN_CREATION_MAX: env.RATE_LIMIT_TOKEN_CREATION_MAX,
    RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS: env.RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS,
    RATE_LIMIT_EMAIL_VERIFICATION_MAX: env.RATE_LIMIT_EMAIL_VERIFICATION_MAX,
    RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS: env.RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    CHALLENGE_DEV_SKIP: env.CHALLENGE_DEV_SKIP,
    UMAMI_HOST: env.UMAMI_HOST,
    UMAMI_WEBSITE_ID: env.UMAMI_WEBSITE_ID,
    SENTRY_DSN: env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
    SENTRY_RELEASE: env.SENTRY_RELEASE,
    SENTRY_TRACES_SAMPLE_RATE: env.SENTRY_TRACES_SAMPLE_RATE,
    SENTRY_PROFILING_SAMPLE_RATE: env.SENTRY_PROFILING_SAMPLE_RATE,
    SENTRY_LOG_LEVEL: env.SENTRY_LOG_LEVEL,
    SENTRY_ENABLE_CONSOLE_LOGGING: env.SENTRY_ENABLE_CONSOLE_LOGGING,
    OPENAPI_INTERACTIVE_DOCS: env.OPENAPI_INTERACTIVE_DOCS,
    OIDC_DEPLOYMENT_PROVIDERS: env.OIDC_DEPLOYMENT_PROVIDERS,
  };
}

export function resolveMigrationDatabaseUrl(
  config: Pick<AppConfig, "DATABASE_URL" | "DATABASE_URL_UNPOOLED">,
): string {
  const unpooled = config.DATABASE_URL_UNPOOLED?.trim();
  return unpooled && unpooled.length > 0 ? unpooled : config.DATABASE_URL;
}

/** Parses env that already has edition presets applied. */
export function parseEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): Omit<AppConfig, "edition"> {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === "production";
  const secretsInput = readSecretsInput(env);
  const flagsInput = readFlagsInput(env);

  if (isProduction) {
    const secretsResult = requiredSecretsSchema.safeParse(secretsInput);
    if (!secretsResult.success) {
      throw new Error(
        `Production startup refused: missing or invalid required secrets - ${secretsResult.error.message}`,
      );
    }

    const flagsResult = optionalFlagsSchema.safeParse(flagsInput);
    if (!flagsResult.success) {
      throw new Error(
        `Production startup refused: invalid deployment flags - ${flagsResult.error.message}`,
      );
    }

    const flags = {
      ...flagsResult.data,
      // SEC-018: never expose interactive OpenAPI docs in production
      OPENAPI_INTERACTIVE_DOCS: false,
    };

    return {
      ...secretsResult.data,
      ...flags,
      nodeEnv,
      isProduction,
    };
  }

  const secretsResult = requiredSecretsSchema.safeParse(secretsInput);
  if (!secretsResult.success) {
    throw new Error(
      `Invalid configuration: missing or invalid required secrets - ${secretsResult.error.message}`,
    );
  }

  const flagsResult = optionalFlagsSchema.safeParse(flagsInput);
  if (!flagsResult.success) {
    throw new Error(
      `Invalid configuration: invalid deployment flags - ${flagsResult.error.message}`,
    );
  }

  return {
    ...secretsResult.data,
    ...flagsResult.data,
    nodeEnv,
    isProduction,
  };
}

export { loadAppConfig as validateEnvConfig } from "./load-config.js";
