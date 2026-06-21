import { adminUsers, dailySnapshots } from "@slugbase/db-admin/schema";
import {
  ensurePublicProductTables,
  resetPublicProductTables,
  seedPublicProductOverviewData,
} from "../../../db-admin/src/public-read/test/public-product-fixture.js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../db-admin/src/migrate/run-migrations.js";
import { bootstrapAdminIfNeeded } from "../auth/bootstrap.service.js";
import { AdminInviteService } from "../auth/invite.service.js";
import { resetLoginRateLimits } from "../auth/rate-limit.js";
import { resetAdminConfigCache } from "../config/load-config.js";
import { parseAdminEnv, type AdminEnv } from "../config/env.schema.js";
import { createAdminDb, type AdminDb } from "../db/create-db.js";
import type { AdminMailMessage, AdminMailSender } from "../mail/smtp-mail.service.js";
import { createApp } from "../server.js";

const FIXED_NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);

class RecordingMailService implements AdminMailSender {
  send(_message: AdminMailMessage): Promise<void> {
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
  const setCookie = response.headers.getSetCookie();
  const cookie = setCookie.find((value) => value.startsWith("slb_admin_session="));
  if (!cookie) {
    throw new Error("Missing slb_admin_session cookie");
  }
  return cookie.split(";")[0] ?? "";
}

async function loginAs(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return extractSessionCookie(response);
}

describe("directory API (integration)", () => {
  let adminDb: AdminDb;
  let config: AdminEnv;
  let sql: postgres.Sql;

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
    sql = postgres(databaseUrl, { max: 1 });
    await ensurePublicProductTables(sql);
  });

  beforeEach(async () => {
    resetAdminConfigCache();
    resetLoginRateLimits();
    await adminDb.sql`TRUNCATE TABLE admin.daily_snapshots, admin.audit_events, admin.admin_sessions, admin.admin_invites, admin.admin_users RESTART IDENTITY CASCADE`;
    await resetPublicProductTables(sql);
    await bootstrapAdminIfNeeded(adminDb, config);
    await seedPublicProductOverviewData(sql, { nowMs: FIXED_NOW_MS });
    await adminDb.db.insert(dailySnapshots).values({
      snapshotDate: "2026-06-14",
      totalAccounts: 2,
      newAccounts: 1,
      verifiedAccounts: 1,
      mfaEnrolledAccounts: 1,
      totalWorkspaces: 2,
      newWorkspaces: 1,
      workspacesByPlan: { free: 1, personal: 1, team: 0 },
      totalBookmarks: 2,
      planArchivedBookmarks: 0,
      totalMemberships: 3,
      activeSubscriptions: 1,
      processedWebhookEvents: 2,
    });
  });

  afterAll(async () => {
    await adminDb.close();
    await sql.end({ timeout: 5 });
  });

  it("returns 401 for unauthenticated directory requests", async () => {
    const app = createApp({ isProduction: true, adminDb, config });

    const response = await app.request("/api/overview");
    expect(response.status).toBe(401);
  });

  it("serves overview, accounts, workspaces, billing, and metrics history for viewers", async () => {
    const app = createApp({ isProduction: true, adminDb, config });
    const mail = new RecordingMailService();
    const inviteService = new AdminInviteService(adminDb, config, undefined, mail);
    const [inviter] = await adminDb.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .limit(1);
    if (!inviter) {
      throw new Error("Expected bootstrap admin user");
    }

    const created = await inviteService.createInvite({
      email: "viewer@slugbase.test",
      role: "viewer",
      invitedByUserId: inviter.id,
    });

    await app.request("/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        password: "viewer-password-12",
      }),
    });

    const viewerCookie = await loginAs(app, "viewer@slugbase.test", "viewer-password-12");

    const overviewResponse = await app.request("/api/overview", {
      headers: { cookie: viewerCookie },
    });
    expect(overviewResponse.status).toBe(200);
    await expect(overviewResponse.json()).resolves.toEqual(
      expect.objectContaining({
        totalAccounts: 3,
        totalWorkspaces: 3,
        freeBookmarkCap: 50,
      }),
    );

    const accountsResponse = await app.request("/api/accounts?page=1&limit=2", {
      headers: { cookie: viewerCookie },
    });
    expect(accountsResponse.status).toBe(200);
    const accountsBody = (await accountsResponse.json()) as {
      items: unknown[];
      pagination: { page: number; limit: number; offset: number; total: number };
    };
    expect(accountsBody.items).toHaveLength(2);
    expect(accountsBody.pagination).toEqual({
      page: 1,
      limit: 2,
      offset: 0,
      total: 3,
    });

    const accountDetailResponse = await app.request("/api/accounts/u-old", {
      headers: { cookie: viewerCookie },
    });
    expect(accountDetailResponse.status).toBe(200);
    await expect(accountDetailResponse.json()).resolves.toEqual({
      account: expect.objectContaining({
        email: "old@slugbase.test",
        memberships: expect.arrayContaining([
          expect.objectContaining({ workspaceName: "Free WS", role: "OWNER" }),
          expect.objectContaining({ workspaceName: "Personal WS", role: "OWNER" }),
        ]),
      }),
    });

    const workspacesResponse = await app.request("/api/workspaces?limit=50", {
      headers: { cookie: viewerCookie },
    });
    expect(workspacesResponse.status).toBe(200);
    const workspacesBody = (await workspacesResponse.json()) as { items: unknown[] };
    expect(workspacesBody.items).toHaveLength(3);
    expect(workspacesBody.items[0]).toEqual(
      expect.objectContaining({
        memberCount: expect.any(Number),
        activeBookmarkCount: expect.any(Number),
      }),
    );

    const workspaceDetailResponse = await app.request("/api/workspaces/ws-free", {
      headers: { cookie: viewerCookie },
    });
    expect(workspaceDetailResponse.status).toBe(200);
    await expect(workspaceDetailResponse.json()).resolves.toEqual({
      workspace: expect.objectContaining({
        freeBookmarkCap: 50,
        members: expect.arrayContaining([
          expect.objectContaining({ email: "old@slugbase.test", role: "OWNER" }),
        ]),
      }),
    });

    const billingResponse = await app.request("/api/billing/summary", {
      headers: { cookie: viewerCookie },
    });
    expect(billingResponse.status).toBe(200);
    await expect(billingResponse.json()).resolves.toEqual(
      expect.objectContaining({
        stripeDashboardUrl: "https://dashboard.stripe.com/",
        workspacesByPlan: expect.any(Array),
        teamSeatUtilization: expect.arrayContaining([
          expect.objectContaining({
            workspaceName: "Team WS",
            planSeats: 5,
            memberCount: 1,
          }),
        ]),
      }),
    );

    const historyResponse = await app.request("/api/metrics/history?page=1&limit=10", {
      headers: { cookie: viewerCookie },
    });
    expect(historyResponse.status).toBe(200);
    const historyBody = (await historyResponse.json()) as { items: Array<{ snapshotDate: string; newAccounts: number }> };
    expect(historyBody.items).toHaveLength(1);
    expect(historyBody.items[0]).toEqual(
      expect.objectContaining({
        snapshotDate: "2026-06-14",
        newAccounts: 1,
      }),
    );
  });

  it("returns 403 when a viewer requests CSV export", async () => {
    const app = createApp({ isProduction: true, adminDb, config });
    const mail = new RecordingMailService();
    const inviteService = new AdminInviteService(adminDb, config, undefined, mail);
    const [inviter] = await adminDb.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .limit(1);
    if (!inviter) {
      throw new Error("Expected bootstrap admin user");
    }

    const created = await inviteService.createInvite({
      email: "viewer-export@slugbase.test",
      role: "viewer",
      invitedByUserId: inviter.id,
    });

    await app.request("/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        password: "viewer-password-12",
      }),
    });

    const viewerCookie = await loginAs(
      app,
      "viewer-export@slugbase.test",
      "viewer-password-12",
    );

    const overviewCsv = await app.request("/api/overview?format=csv", {
      headers: { cookie: viewerCookie },
    });
    expect(overviewCsv.status).toBe(403);

    const historyCsv = await app.request("/api/metrics/history?format=csv", {
      headers: { cookie: viewerCookie },
    });
    expect(historyCsv.status).toBe(403);
  });

  it("allows operators to export aggregate CSV for overview and history", async () => {
    const app = createApp({ isProduction: true, adminDb, config });
    const operatorCookie = await loginAs(
      app,
      "bootstrap@slugbase.test",
      "bootstrap-password-12",
    );

    const overviewCsv = await app.request("/api/overview?format=csv", {
      headers: { cookie: operatorCookie },
    });
    expect(overviewCsv.status).toBe(200);
    expect(overviewCsv.headers.get("content-type")).toContain("text/csv");
    const overviewText = await overviewCsv.text();
    expect(overviewText).toContain("total_accounts,3");
    expect(overviewText).not.toContain("old@slugbase.test");

    const historyCsv = await app.request("/api/metrics/history?format=csv", {
      headers: { cookie: operatorCookie },
    });
    expect(historyCsv.status).toBe(200);
    expect(historyCsv.headers.get("content-type")).toContain("text/csv");
    const historyText = await historyCsv.text();
    expect(historyText).toContain("snapshot_date,total_accounts");
    expect(historyText).toContain("2026-06-14,2");
    expect(historyText).not.toContain("@slugbase.test");
  });

  it("returns 404 for unknown account and workspace ids", async () => {
    const app = createApp({ isProduction: true, adminDb, config });
    const cookie = await loginAs(
      app,
      "bootstrap@slugbase.test",
      "bootstrap-password-12",
    );

    const missingAccount = await app.request("/api/accounts/missing-account", {
      headers: { cookie },
    });
    expect(missingAccount.status).toBe(404);

    const missingWorkspace = await app.request("/api/workspaces/missing-workspace", {
      headers: { cookie },
    });
    expect(missingWorkspace.status).toBe(404);
  });
});
