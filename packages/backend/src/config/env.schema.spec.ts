import { describe, expect, it } from "vitest";

import {
  productionEnvWithoutSessionSecret,
  validTestEnv,
} from "../test-utils/test-env.js";
import { validateEnvConfig } from "./env.schema.js";

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
});
