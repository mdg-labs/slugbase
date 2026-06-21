import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigService } from "../../config/config.service.js";
import type { AppConfig } from "../../config/env.schema.js";
import { validTestEnv } from "../../test-utils/test-env.js";
import { CsrfService } from "./csrf.service.js";

function createCsrfService(overrides: Partial<AppConfig> = {}): CsrfService {
  const config: AppConfig = {
    SESSION_SECRET: validTestEnv.SESSION_SECRET ?? "",
    ENCRYPTION_KEY: validTestEnv.ENCRYPTION_KEY ?? "",
    DATABASE_URL: validTestEnv.DATABASE_URL ?? "",
    APP_BASE_URL: validTestEnv.APP_BASE_URL ?? "",
    FRONTEND_ORIGIN: validTestEnv.FRONTEND_ORIGIN ?? "",
    PUBLIC_REGISTRATION: false,
    EMAIL_VERIFICATION_REQUIRED: false,
    PORT: 3000,
    SERVE_WEB_CLIENT: false,
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    OPENAI_MODEL: "gpt-4o-mini",
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
    DOWNGRADE_GRACE_PERIOD_DAYS: 7,
    nodeEnv: "test",
    isProduction: false,
    edition: "ce",
    ...overrides,
  };

  return new CsrfService(new ConfigService(config));
}

describe("CsrfService", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("round-trips token generation and verification", () => {
    const csrf = createCsrfService();
    const token = csrf.generateToken();

    expect(csrf.verifyToken(token)).toBe(true);
  });

  it("rejects tokens with an invalid MAC", () => {
    const csrf = createCsrfService();
    const token = csrf.generateToken();
    const idx = token.lastIndexOf(".");
    const value = token.slice(0, idx);
    const macBuf = Buffer.from(token.slice(idx + 1), "base64url");
    macBuf[0] = (macBuf[0] ?? 0) ^ 0xff;
    const tampered = `${value}.${macBuf.toString("base64url")}`;

    expect(csrf.verifyToken(tampered)).toBe(false);
  });

  it("rejects tokens with a MAC of the wrong length", () => {
    const csrf = createCsrfService();
    const token = csrf.generateToken();
    const idx = token.lastIndexOf(".");
    const value = token.slice(0, idx);

    expect(csrf.verifyToken(`${value}.tooshort`)).toBe(false);
  });
});
