import { adminSessions, adminUsers } from "@slugbase/db-admin/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../db-admin/src/migrate/run-migrations.js";
import { bootstrapAdminIfNeeded } from "./bootstrap.service.js";
import { resetLoginRateLimits } from "./rate-limit.js";
import { resetAdminConfigCache } from "../config/load-config.js";
import { parseAdminEnv, type AdminEnv } from "../config/env.schema.js";
import { createAdminDb, type AdminDb } from "../db/create-db.js";
import { createApp } from "../server.js";
import type { AdminMailMessage, AdminMailSender } from "../mail/smtp-mail.service.js";
import { AdminInviteService } from "./invite.service.js";

class RecordingMailService implements AdminMailSender {
  readonly sent: AdminMailMessage[] = [];

  send(message: AdminMailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

const baseEnv: Record<string, string> = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
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
  ADMIN_BOOTSTRAP_EMAIL: "bootstrap@slugbase.test",
  ADMIN_BOOTSTRAP_PASSWORD: "bootstrap-password-12",
};

function extractSessionCookie(response: Response): string {
  const setCookieHeader = response.headers.get("set-cookie");
  const setCookie = response.headers.getSetCookie();
  const cookies = setCookie.length > 0
    ? setCookie
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  const cookie = cookies.find((value) => value.startsWith("slb_admin_session="));
  if (!cookie) {
    throw new Error("Missing slb_admin_session cookie");
  }
  return cookie.split(";")[0] ?? "";
}

describe("admin auth (integration)", () => {
  let adminDb: AdminDb;
  let config: AdminEnv;
  let mail: RecordingMailService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    baseEnv.DATABASE_URL = databaseUrl;
    resetAdminConfigCache();
    config = parseAdminEnv(baseEnv);
    await runMigrations(databaseUrl);
    adminDb = createAdminDb(databaseUrl);
    mail = new RecordingMailService();
  });

  beforeEach(async () => {
    resetAdminConfigCache();
    resetLoginRateLimits();
    mail.sent.length = 0;
    await adminDb.sql`TRUNCATE TABLE admin.audit_events, admin.admin_sessions, admin.admin_invites, admin.admin_users RESTART IDENTITY CASCADE`;
    await bootstrapAdminIfNeeded(adminDb, config);
  });

  afterAll(async () => {
    await adminDb.close();
  });

  it("bootstraps the first platform admin when admin_users is empty", async () => {
    const rows = await adminDb.db.select().from(adminUsers);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("bootstrap@slugbase.test");
    expect(rows[0]?.role).toBe("platform_admin");
  });

  it("logs in and returns the current operator", async () => {
    const app = createApp({ isProduction: true, adminDb, config });

    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bootstrap@slugbase.test",
        password: "bootstrap-password-12",
      }),
    });

    expect(loginResponse.status).toBe(200);
    const cookie = extractSessionCookie(loginResponse);

    const meResponse = await app.request("/api/auth/me", {
      headers: { cookie },
    });

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toEqual({
      id: expect.any(String),
      email: "bootstrap@slugbase.test",
      role: "platform_admin",
    });
  });

  it("rejects expired sessions", async () => {
    const app = createApp({ isProduction: true, adminDb, config });

    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bootstrap@slugbase.test",
        password: "bootstrap-password-12",
      }),
    });
    const cookie = extractSessionCookie(loginResponse);

    await adminDb.db
      .update(adminSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) });

    const meResponse = await app.request("/api/auth/me", {
      headers: { cookie },
    });
    expect(meResponse.status).toBe(401);
  });

  it("returns 403 when a viewer attempts platform-admin invite management", async () => {
    const app = createApp({
      isProduction: true,
      adminDb,
      config,
    });

    const inviteService = new AdminInviteService(adminDb, config, undefined, mail);
    const platformLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bootstrap@slugbase.test",
        password: "bootstrap-password-12",
      }),
    });
    const platformCookie = extractSessionCookie(platformLogin);

    const platformUsers = await adminDb.db.select().from(adminUsers).limit(1);
    const inviterId = platformUsers[0]?.id;
    if (!inviterId) {
      throw new Error("Expected bootstrap admin user");
    }

    const created = await inviteService.createInvite({
      email: "viewer@slugbase.test",
      role: "viewer",
      invitedByUserId: inviterId,
    });

    const acceptResponse = await app.request("/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        password: "viewer-password-12",
      }),
    });
    expect(acceptResponse.status).toBe(200);

    const viewerLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "viewer@slugbase.test",
        password: "viewer-password-12",
      }),
    });
    const viewerCookie = extractSessionCookie(viewerLogin);

    const forbidden = await app.request("/api/auth/invites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie,
      },
      body: JSON.stringify({
        email: "another@slugbase.test",
        role: "operator",
      }),
    });

    expect(forbidden.status).toBe(403);
    expect(platformCookie).toContain("slb_admin_session=");
  });

  it("accepts an invite and establishes a session", async () => {
    const app = createApp({ isProduction: true, adminDb, config });
    const inviteService = new AdminInviteService(adminDb, config, undefined, mail);
    const inviterRows = await adminDb.db.select().from(adminUsers).limit(1);
    const inviterId = inviterRows[0]?.id;
    if (!inviterId) {
      throw new Error("Expected bootstrap admin user");
    }

    const created = await inviteService.createInvite({
      email: "operator@slugbase.test",
      role: "operator",
      invitedByUserId: inviterId,
    });

    expect(mail.sent).toHaveLength(1);

    const acceptResponse = await app.request("/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        password: "operator-password-12",
      }),
    });

    expect(acceptResponse.status).toBe(200);
    const cookie = extractSessionCookie(acceptResponse);

    const meResponse = await app.request("/api/auth/me", {
      headers: { cookie },
    });

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toEqual({
      id: expect.any(String),
      email: "operator@slugbase.test",
      role: "operator",
    });

    const acceptedUser = await adminDb.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.email, "operator@slugbase.test"))
      .limit(1);
    expect(acceptedUser[0]?.role).toBe("operator");
  });
});
