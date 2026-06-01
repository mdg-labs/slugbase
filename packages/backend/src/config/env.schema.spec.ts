import { describe, expect, it } from "vitest";

import {
  productionEnvWithoutSessionSecret,
  validTestEnv,
} from "../test-utils/test-env.js";
import { resolveMigrationDatabaseUrl, validateEnvConfig } from "./env.schema.js";

describe("validateEnvConfig", () => {
  it("accepts valid secrets in production mode", () => {
    const config = validateEnvConfig({
      ...validTestEnv,
      NODE_ENV: "production",
    });

    expect(config.isProduction).toBe(true);
    expect(config.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("throws when SESSION_SECRET is missing in production mode", () => {
    expect(() =>
      validateEnvConfig(productionEnvWithoutSessionSecret()),
    ).toThrow(/Production startup refused/);
  });

  it("throws when SESSION_SECRET is too short in production mode", () => {
    expect(() =>
      validateEnvConfig({
        ...validTestEnv,
        NODE_ENV: "production",
        SESSION_SECRET: "too-short",
      }),
    ).toThrow(/Production startup refused/);
  });

  it("parses SERVE_WEB_CLIENT=false from Infisical-style string env", () => {
    const config = validateEnvConfig({
      ...validTestEnv,
      NODE_ENV: "production",
      SERVE_WEB_CLIENT: "false",
    });

    expect(config.SERVE_WEB_CLIENT).toBe(false);
  });

  it("prefers DATABASE_URL_UNPOOLED for migration URL resolution", () => {
    const config = validateEnvConfig({
      ...validTestEnv,
      DATABASE_URL: "postgresql://pooled.example/db",
      DATABASE_URL_UNPOOLED: "postgresql://direct.example/db",
    });

    expect(resolveMigrationDatabaseUrl(config)).toBe(
      "postgresql://direct.example/db",
    );
  });

  it("falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is unset", () => {
    const config = validateEnvConfig({
      ...validTestEnv,
      DATABASE_URL: "postgresql://pooled.example/db",
    });

    expect(resolveMigrationDatabaseUrl(config)).toBe(
      "postgresql://pooled.example/db",
    );
  });
});
