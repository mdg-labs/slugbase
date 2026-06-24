import { describe, expect, it } from "vitest";

import { SLUGBASE_EDITION } from "@slugbase/shared-types";

import { loadAppConfig } from "./config/load-config.js";
import { shouldRunBootstrapMigrations } from "./main.js";

const baseEnv = {
  NODE_ENV: "production",
  SESSION_SECRET: "x".repeat(32),
  ENCRYPTION_KEY: "y".repeat(32),
  DATABASE_URL: "postgresql://slugbase:slugbase@localhost:5432/slugbase",
  APP_BASE_URL: "https://app.example.com",
  FRONTEND_ORIGIN: "https://app.example.com",
} as const;

describe("shouldRunBootstrapMigrations", () => {
  it("runs for CE combined image (SERVE_WEB_CLIENT=true)", () => {
    const config = loadAppConfig({
      ...baseEnv,
      SLUGBASE_EDITION: SLUGBASE_EDITION.CE,
      SERVE_WEB_CLIENT: "true",
      WEB_CLIENT_SERVER_BUILD: "/app/packages/web/build/server/index.js",
    });
    expect(shouldRunBootstrapMigrations(config)).toBe(true);
  });

  it("runs for CE split API image (SERVE_WEB_CLIENT=false)", () => {
    const config = loadAppConfig({
      ...baseEnv,
      SLUGBASE_EDITION: SLUGBASE_EDITION.CE,
      SERVE_WEB_CLIENT: "false",
    });
    expect(shouldRunBootstrapMigrations(config)).toBe(true);
  });

  it("skips for hosted Cloud API (SERVE_WEB_CLIENT=false)", () => {
    const config = loadAppConfig({
      ...baseEnv,
      SLUGBASE_EDITION: SLUGBASE_EDITION.CLOUD,
      SERVE_WEB_CLIENT: "false",
    });
    expect(shouldRunBootstrapMigrations(config)).toBe(false);
  });
});
