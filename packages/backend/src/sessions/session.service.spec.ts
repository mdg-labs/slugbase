import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigService } from "../config/config.service.js";
import type { AppConfig } from "../config/env.schema.js";
import { validTestEnv } from "../test-utils/test-env.js";
import { SessionService } from "./session.service.js";

function createSessionService(overrides: Partial<AppConfig> = {}): SessionService {
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
    ...overrides,
  };

  return new SessionService({ getOrm: () => ({}) } as never, new ConfigService(config));
}

describe("SessionService", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("round-trips session cookie signing and verification", () => {
    const sessions = createSessionService();
    const sessionId = "0123456789abcdef0123456789abcdef";
    const cookieValue = sessions.signSessionId(sessionId);

    expect(sessions.verifySessionCookie(cookieValue)).toBe(sessionId);
  });

  it("returns null for cookies with an invalid MAC", () => {
    const sessions = createSessionService();
    const sessionId = "0123456789abcdef0123456789abcdef";
    const cookieValue = sessions.signSessionId(sessionId);
    const idx = cookieValue.lastIndexOf(".");
    const value = cookieValue.slice(0, idx);
    const macBuf = Buffer.from(cookieValue.slice(idx + 1), "base64url");
    macBuf[0] = (macBuf[0] ?? 0) ^ 0xff;
    const tampered = `${value}.${macBuf.toString("base64url")}`;

    expect(sessions.verifySessionCookie(tampered)).toBeNull();
  });

  it("returns null for cookies with a MAC of the wrong length", () => {
    const sessions = createSessionService();
    const sessionId = "0123456789abcdef0123456789abcdef";

    expect(sessions.verifySessionCookie(`${sessionId}.tooshort`)).toBeNull();
  });
});
