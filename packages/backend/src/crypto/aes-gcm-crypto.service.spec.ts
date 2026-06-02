import { CryptoDecryptError } from "@slugbase/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigService } from "../config/config.service.js";
import type { AppConfig } from "../config/env.schema.js";
import { validTestEnv } from "../test-utils/test-env.js";
import { AesGcmCryptoService } from "./aes-gcm-crypto.service.js";

function createCryptoService(overrides: Partial<AppConfig> = {}): AesGcmCryptoService {
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
    OPENAPI_INTERACTIVE_DOCS: true,
    TEAM_BASE_SEATS: 5,
    DOWNGRADE_GRACE_PERIOD_DAYS: 7,
    nodeEnv: "test",
    isProduction: false,
    ...overrides,
  };

  return new AesGcmCryptoService(new ConfigService(config));
}

describe("AesGcmCryptoService", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("round-trips plaintext with ENCRYPTION_KEY", () => {
    const crypto = createCryptoService();
    const plaintext = "smtp-password-rotated-2026";

    const ciphertext = crypto.encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.startsWith("sb1:")).toBe(true);
    expect(crypto.decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces distinct ciphertext for the same plaintext", () => {
    const crypto = createCryptoService();
    const first = crypto.encrypt("same-value");
    const second = crypto.encrypt("same-value");

    expect(first).not.toBe(second);
    expect(crypto.decrypt(first)).toBe("same-value");
    expect(crypto.decrypt(second)).toBe("same-value");
  });

  it("throws in strict mode when decrypting with a different key", () => {
    const encryptor = createCryptoService({
      ENCRYPTION_KEY: "primary-encryption-key-32-chars-min",
      isProduction: true,
      nodeEnv: "production",
    });
    const decryptor = createCryptoService({
      ENCRYPTION_KEY: "secondary-encryption-key-32-chars",
      isProduction: true,
      nodeEnv: "production",
    });

    const ciphertext = encryptor.encrypt("secret-value");

    expect(() => decryptor.decrypt(ciphertext)).toThrow(CryptoDecryptError);
  });

  it("returns empty string in non-strict mode on decrypt failure", () => {
    const encryptor = createCryptoService({
      ENCRYPTION_KEY: "primary-encryption-key-32-chars-min",
    });
    const decryptor = createCryptoService({
      ENCRYPTION_KEY: "secondary-encryption-key-32-chars",
      isProduction: false,
    });

    const ciphertext = encryptor.encrypt("secret-value");

    expect(decryptor.decrypt(ciphertext)).toBe("");
  });
});
