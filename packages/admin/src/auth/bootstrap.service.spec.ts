import { describe, expect, it, vi } from "vitest";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import {
  AdminBootstrapError,
  bootstrapAdminIfNeeded,
} from "./bootstrap.service.js";
import type { AdminPasswordService } from "./password.service.js";

const baseConfig = {
  DATABASE_URL: "postgresql://slugbase:slugbase@localhost:5432/slugbase",
  NODE_ENV: "production",
  SLUGBASE_EDITION: "cloud",
  PORT: 3000,
  ADMIN_URL: "https://admin.slugbase.app",
  SMTP_HOST: "localhost",
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: "user",
  SMTP_PASS: "password",
  SMTP_FROM: "noreply@slugbase.test",
  ADMIN_SESSION_TTL_DAYS: 7,
  ADMIN_SNAPSHOT_CRON: "0 2 * * *",
  ADMIN_ALERT_SIGNUP_SPIKE_MULTIPLIER: 3,
} as const satisfies Omit<
  AdminEnv,
  "ADMIN_BOOTSTRAP_EMAIL" | "ADMIN_BOOTSTRAP_PASSWORD"
>;

function createMockAdminDb(userCount: number): AdminDb {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });
  const from = vi.fn().mockResolvedValue([{ value: userCount }]);
  const select = vi.fn().mockReturnValue({ from });

  return {
    db: { select, insert },
    sql: {} as AdminDb["sql"],
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminDb;
}

function createPasswords(): AdminPasswordService {
  return {
    hashPassword: vi.fn().mockResolvedValue("$argon2id$hash"),
    verifyPassword: vi.fn(),
    assertPasswordPolicy: vi.fn(),
  };
}

describe("bootstrapAdminIfNeeded", () => {
  it("creates the first platform admin when admin_users is empty and bootstrap env is set", async () => {
    const adminDb = createMockAdminDb(0);
    const passwords = createPasswords();
    const config: AdminEnv = {
      ...baseConfig,
      ADMIN_BOOTSTRAP_EMAIL: "bootstrap@slugbase.test",
      ADMIN_BOOTSTRAP_PASSWORD: "bootstrap-password-12",
    };

    await bootstrapAdminIfNeeded(adminDb, config, passwords);

    expect(passwords.hashPassword).toHaveBeenCalledWith("bootstrap-password-12");
    expect(adminDb.db.insert).toHaveBeenCalledOnce();
  });

  it("throws when admin_users is empty and bootstrap env is missing", async () => {
    const adminDb = createMockAdminDb(0);
    const config: AdminEnv = { ...baseConfig };

    await expect(bootstrapAdminIfNeeded(adminDb, config)).rejects.toThrow(
      AdminBootstrapError,
    );
    await expect(bootstrapAdminIfNeeded(adminDb, config)).rejects.toThrow(
      "ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required when no admin users exist",
    );
    expect(adminDb.db.insert).not.toHaveBeenCalled();
  });

  it("returns without creating a second admin when users exist and bootstrap env is still set", async () => {
    const adminDb = createMockAdminDb(1);
    const passwords = createPasswords();
    const config: AdminEnv = {
      ...baseConfig,
      ADMIN_BOOTSTRAP_EMAIL: "bootstrap@slugbase.test",
      ADMIN_BOOTSTRAP_PASSWORD: "bootstrap-password-12",
    };

    await expect(
      bootstrapAdminIfNeeded(adminDb, config, passwords),
    ).resolves.toBeUndefined();

    expect(passwords.hashPassword).not.toHaveBeenCalled();
    expect(adminDb.db.insert).not.toHaveBeenCalled();
  });

  it("returns without error when users exist and bootstrap env is absent", async () => {
    const adminDb = createMockAdminDb(1);
    const config: AdminEnv = { ...baseConfig };

    await expect(bootstrapAdminIfNeeded(adminDb, config)).resolves.toBeUndefined();
    expect(adminDb.db.insert).not.toHaveBeenCalled();
  });
});
