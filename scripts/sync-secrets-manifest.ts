/**
 * Canonical sync-secrets manifest for SlugBase hosted deploy (spec §22.9, §14.7).
 * Validated against `.github/scripts/sync-secrets.sh` and `.github/workflows/sync-secrets.yml`.
 */

export type SyncSecretsService = "api" | "web" | "marketing";

export type SyncSecretsManifest = {
  services: Record<
    SyncSecretsService,
    {
      requiredGhaKeys: readonly string[];
      runtimeKeys: readonly string[];
    }
  >;
  /** GHA secrets required to run sync-secrets.sh (platform tokens; not pushed to apps). */
  platformGhaKeys: readonly string[];
  /**
   * GHA storage keys mapped to a different runtime key before platform sync
   * (see `.github/scripts/github-secret-map.sh`).
   */
  storageToRuntimeAliases: Readonly<Record<string, string>>;
};

export const SYNC_SECRETS_MANIFEST: SyncSecretsManifest = {
  platformGhaKeys: [
    "FLY_API_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ],
  storageToRuntimeAliases: {
    SENTRY_DSN_API: "SENTRY_DSN",
  },
  services: {
    api: {
      requiredGhaKeys: [
        "SESSION_SECRET",
        "ENCRYPTION_KEY",
        "DATABASE_URL",
        "APP_BASE_URL",
        "FRONTEND_ORIGIN",
      ],
      runtimeKeys: [
        "NODE_ENV",
        "SLUGBASE_EDITION",
        "SESSION_SECRET",
        "ENCRYPTION_KEY",
        "DATABASE_URL",
        "APP_BASE_URL",
        "FRONTEND_ORIGIN",
        "MARKETING_ORIGIN",
        "PUBLIC_REGISTRATION",
        "EMAIL_VERIFICATION_REQUIRED",
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_SECURE",
        "SMTP_USER",
        "SMTP_PASS",
        "SMTP_FROM",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_PERSONAL_MONTHLY",
        "STRIPE_PRICE_PERSONAL_ANNUAL",
        "STRIPE_PRICE_TEAM_MONTHLY",
        "STRIPE_PRICE_TEAM_ANNUAL",
        "STRIPE_PRICE_SUPPORTER",
        "SUPPORTER_PROMOTION_END",
        "DOWNGRADE_GRACE_PERIOD_DAYS",
        "SESSION_TTL_DAYS",
        "SESSION_REMEMBER_TTL_DAYS",
        "MFA_TOTP_ISSUER",
        "RATE_LIMIT_LOGIN_MAX",
        "RATE_LIMIT_LOGIN_TTL_SECONDS",
        "RATE_LIMIT_TOKEN_CREATION_MAX",
        "RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS",
        "RATE_LIMIT_EMAIL_VERIFICATION_MAX",
        "RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS",
        "TURNSTILE_SECRET_KEY",
        "CHALLENGE_DEV_SKIP",
        "UMAMI_HOST",
        "UMAMI_WEBSITE_ID",
        "SENTRY_DSN",
        "SENTRY_ENVIRONMENT",
        "SENTRY_TRACES_SAMPLE_RATE",
        "SENTRY_PROFILING_SAMPLE_RATE",
        "SENTRY_REPLAY_SAMPLE_RATE",
        "SENTRY_LOG_LEVEL",
        "SENTRY_ENABLE_CONSOLE_LOGGING",
        "OIDC_DEPLOYMENT_PROVIDERS",
      ],
    },
    web: {
      requiredGhaKeys: ["API_BASE_URL"],
      runtimeKeys: ["API_BASE_URL"],
    },
    marketing: {
      requiredGhaKeys: [],
      runtimeKeys: [],
    },
  },
};

/** GHA keys that must appear in sync-secrets.yml env (storage names, not runtime aliases). */
export function workflowSecretKeys(manifest: SyncSecretsManifest = SYNC_SECRETS_MANIFEST): string[] {
  const keys = new Set<string>([
    ...manifest.platformGhaKeys,
    "NODE_ENV",
    "FLY_SECRETS_MODE",
  ]);

  for (const service of Object.values(manifest.services)) {
    for (const key of service.requiredGhaKeys) {
      keys.add(key);
    }
    for (const runtimeKey of service.runtimeKeys) {
      const storageKey =
        Object.entries(manifest.storageToRuntimeAliases).find(
          ([, runtime]) => runtime === runtimeKey,
        )?.[0] ?? runtimeKey;
      keys.add(storageKey);
    }
  }

  for (const storageKey of Object.keys(manifest.storageToRuntimeAliases)) {
    keys.add(storageKey);
  }

  keys.delete("FLY_SECRETS_MODE");
  return [...keys].sort();
}
