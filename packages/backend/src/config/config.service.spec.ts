import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./env.schema.js";
import { ConfigService } from "./config.service.js";

function createConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    SESSION_SECRET: "test-session-secret-with-32-chars-min",
    ENCRYPTION_KEY: "test-encryption-key-with-32-chars",
    DATABASE_URL: "postgresql://slugbase:slugbase@localhost:5432/slugbase_test",
    APP_BASE_URL: "https://api.slugbase.test",
    FRONTEND_ORIGIN: "https://app.slugbase.test",
    PUBLIC_REGISTRATION: false,
    EMAIL_VERIFICATION_REQUIRED: false,
    PORT: 3000,
    SERVE_WEB_CLIENT: false,
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    OPENAI_MODEL: "gpt-4o-mini",
    DOWNGRADE_GRACE_PERIOD_DAYS: 7,
    SESSION_TTL_DAYS: 30,
    SESSION_REMEMBER_TTL_DAYS: 90,
    MFA_TOTP_ISSUER: "SlugBase",
    RATE_LIMIT_LOGIN_MAX: 10,
    RATE_LIMIT_LOGIN_TTL_SECONDS: 900,
    RATE_LIMIT_TOKEN_CREATION_MAX: 20,
    RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS: 3600,
    RATE_LIMIT_EMAIL_VERIFICATION_MAX: 3,
    RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS: 3600,
    OPENAPI_INTERACTIVE_DOCS: true,
    SENTRY_ENABLE_CONSOLE_LOGGING: false,
    nodeEnv: "production",
    isProduction: true,
    edition: "cloud",
    ...overrides,
  };
}

describe("ConfigService.cookieSecure", () => {
  const originalE2eMode = process.env.SLUGBASE_E2E_MODE;

  afterEach(() => {
    if (originalE2eMode === undefined) {
      delete process.env.SLUGBASE_E2E_MODE;
    } else {
      process.env.SLUGBASE_E2E_MODE = originalE2eMode;
    }
  });

  it("returns false when APP_BASE_URL uses http, even in production", () => {
    delete process.env.SLUGBASE_E2E_MODE;
    const service = new ConfigService(
      createConfig({ APP_BASE_URL: "http://slugbase.local:3000" }),
    );
    expect(service.cookieSecure()).toBe(false);
  });

  it("returns true when APP_BASE_URL uses https in production", () => {
    delete process.env.SLUGBASE_E2E_MODE;
    const service = new ConfigService(
      createConfig({ APP_BASE_URL: "https://slugbase.example.com" }),
    );
    expect(service.cookieSecure()).toBe(true);
  });

  it("returns false when SLUGBASE_E2E_MODE is set, regardless of APP_BASE_URL", () => {
    process.env.SLUGBASE_E2E_MODE = "true";
    const service = new ConfigService(
      createConfig({ APP_BASE_URL: "https://slugbase.example.com" }),
    );
    expect(service.cookieSecure()).toBe(false);
  });

  it("exposes edition for diagnostics", () => {
    const service = new ConfigService(createConfig({ edition: "ce" }));
    expect(service.getEdition()).toBe("ce");
  });
});
