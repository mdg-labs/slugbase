import { describe, expect, it } from "vitest";

import { parseAdminEnv } from "./env.schema.js";

const baseEnv = {
  DATABASE_URL: "postgresql://slugbase:slugbase@localhost:5432/slugbase",
  NODE_ENV: "production",
  SLUGBASE_EDITION: "cloud",
  PORT: "3000",
  ADMIN_URL: "https://admin.slugbase.app",
  SMTP_HOST: "localhost",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "user",
  SMTP_PASS: "password",
  SMTP_FROM: "noreply@slugbase.test",
} as const;

describe("parseAdminEnv", () => {
  it("parses production config without bootstrap credentials", () => {
    const config = parseAdminEnv({ ...baseEnv });

    expect(config.NODE_ENV).toBe("production");
    expect(config.ADMIN_BOOTSTRAP_EMAIL).toBeUndefined();
    expect(config.ADMIN_BOOTSTRAP_PASSWORD).toBeUndefined();
  });

  it("parses production config when bootstrap credentials are still present", () => {
    const config = parseAdminEnv({
      ...baseEnv,
      ADMIN_BOOTSTRAP_EMAIL: "bootstrap@slugbase.test",
      ADMIN_BOOTSTRAP_PASSWORD: "bootstrap-password-12",
    });

    expect(config.ADMIN_BOOTSTRAP_EMAIL).toBe("bootstrap@slugbase.test");
    expect(config.ADMIN_BOOTSTRAP_PASSWORD).toBe("bootstrap-password-12");
  });
});
