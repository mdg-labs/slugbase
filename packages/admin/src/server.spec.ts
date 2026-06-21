import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAdminConfigCache } from "./config/load-config.js";
import { createApp } from "./server.js";

const testEnv = {
  DATABASE_URL: "postgresql://slugbase:slugbase@localhost:5432/slugbase",
  NODE_ENV: "test",
  SLUGBASE_EDITION: "cloud",
  PORT: "3000",
  ADMIN_URL: "http://localhost:3000",
  SMTP_HOST: "localhost",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "user",
  SMTP_PASS: "password",
  SMTP_FROM: "noreply@slugbase.test",
} as const;

describe("GET /health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAdminConfigCache();
  });

  it("returns ok status for the admin service", async () => {
    for (const [key, value] of Object.entries(testEnv)) {
      vi.stubEnv(key, value);
    }

    const app = createApp({ isProduction: true });
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "slugbase-admin",
    });
  });
});
