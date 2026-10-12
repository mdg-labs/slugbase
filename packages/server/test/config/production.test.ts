import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ProcessType } from "../../src/config/index.ts";
import {
  DEVELOPMENT_APP_ORIGIN,
  DEVELOPMENT_DATABASE_MIGRATE_URL,
  DEVELOPMENT_DATABASE_URL,
  DEVELOPMENT_ENCRYPTION_KEY,
  DEVELOPMENT_ENCRYPTION_KEY_ID,
  DEVELOPMENT_SESSION_SECRET,
} from "../../src/config/development-defaults.ts";
import { productionEnv } from "./support.ts";

function refusedKeys(type: ProcessType, env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(type, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...new Set(error.issues.map((issue) => issue.key))].sort();
    }
    throw error;
  }
  return [];
}

describe("production refusals (doc 01 section 11)", () => {
  it.each(["server", "worker", "migrate"] as const)("starts %s with a sound production environment", (type) => {
    expect(refusedKeys(type, productionEnv())).toEqual([]);
  });

  it.each([
    ["SESSION_SECRET is missing", { SESSION_SECRET: undefined }, "SESSION_SECRET"],
    ["SESSION_SECRET is empty", { SESSION_SECRET: "" }, "SESSION_SECRET"],
    ["SESSION_SECRET is short", { SESSION_SECRET: "a".repeat(31) }, "SESSION_SECRET"],
    ["ENCRYPTION_KEY is missing", { ENCRYPTION_KEY: undefined }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY decodes to 31 bytes", { ENCRYPTION_KEY: Buffer.alloc(31, 7).toString("base64") }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY decodes to 33 bytes", { ENCRYPTION_KEY: Buffer.alloc(33, 7).toString("base64") }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY is not base64", { ENCRYPTION_KEY: "not base64 !!".padEnd(44, "?") }, "ENCRYPTION_KEY"],
    ["APP_ORIGIN is http", { APP_ORIGIN: "http://bookmarks.example.com" }, "APP_ORIGIN"],
    ["APP_ORIGIN is missing", { APP_ORIGIN: undefined }, "APP_ORIGIN"],
    ["APP_ORIGIN is the development default", { APP_ORIGIN: DEVELOPMENT_APP_ORIGIN }, "APP_ORIGIN"],
    ["SESSION_SECRET is the development default", { SESSION_SECRET: DEVELOPMENT_SESSION_SECRET }, "SESSION_SECRET"],
    ["ENCRYPTION_KEY is the development default", { ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY }, "ENCRYPTION_KEY"],
    ["ENCRYPTION_KEY_ID is the development default", { ENCRYPTION_KEY_ID: DEVELOPMENT_ENCRYPTION_KEY_ID }, "ENCRYPTION_KEY_ID"],
    ["DATABASE_URL is the development default", { DATABASE_URL: DEVELOPMENT_DATABASE_URL }, "DATABASE_URL"],
    [
      "DATABASE_URL keeps the development password on another host",
      { DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@db.internal:5432/slugbase" },
      "DATABASE_URL",
    ],
    ["DATABASE_MIGRATE_URL is the development default", { DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL }, "DATABASE_MIGRATE_URL"],
  ])("refuses to start the server when %s", (_name, overrides, key) => {
    expect(refusedKeys("server", productionEnv(overrides))).toContain(key);
  });

  it("refuses the worker and migrate for their own keys", () => {
    expect(refusedKeys("worker", productionEnv({ SESSION_SECRET: "short" }))).toEqual(["SESSION_SECRET"]);
    expect(refusedKeys("migrate", productionEnv({ DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL }))).toEqual([
      "DATABASE_MIGRATE_URL",
    ]);
  });

  it("accepts a development default outside production", () => {
    const development = productionEnv({
      NODE_ENV: "development",
      APP_ORIGIN: DEVELOPMENT_APP_ORIGIN,
      SESSION_SECRET: DEVELOPMENT_SESSION_SECRET,
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      ENCRYPTION_KEY_ID: DEVELOPMENT_ENCRYPTION_KEY_ID,
      DATABASE_URL: DEVELOPMENT_DATABASE_URL,
      DATABASE_MIGRATE_URL: DEVELOPMENT_DATABASE_MIGRATE_URL,
    });
    expect(refusedKeys("server", development)).toEqual([]);
  });

  it("accepts a short session secret outside production, and still requires the encryption key to decode", () => {
    expect(refusedKeys("server", productionEnv({ NODE_ENV: "test", APP_ORIGIN: "http://localhost:5173", SESSION_SECRET: "x" }))).toEqual([]);
    expect(refusedKeys("server", productionEnv({ NODE_ENV: "test", ENCRYPTION_KEY: "x" }))).toEqual(["ENCRYPTION_KEY"]);
  });
});
