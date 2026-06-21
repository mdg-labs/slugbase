import { adminUsers, dailySnapshots } from "@slugbase/db-admin/schema";
import {
  ensurePublicProductTables,
  resetPublicProductTables,
} from "../../../db-admin/src/public-read/test/public-product-fixture.js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../db-admin/src/migrate/run-migrations.js";
import { bootstrapAdminIfNeeded } from "../auth/bootstrap.service.js";
import { AdminInviteService } from "../auth/invite.service.js";
import { resetAdminConfigCache } from "../config/load-config.js";
import { parseAdminEnv, type AdminEnv } from "../config/env.schema.js";
import { createAdminDb, type AdminDb } from "../db/create-db.js";
import type { AdminMailMessage, AdminMailSender } from "../mail/smtp-mail.service.js";
import { createSnapshotJob } from "./snapshot.job.js";
import { RetentionJob } from "./retention.job.js";
import { createApp } from "../server.js";
const SNAPSHOT_DATE = "2026-06-20";

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

async function ensureWorkspaceMembersTable(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.workspace_members (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL,
      joined_at bigint NOT NULL
    );
  `);
}

async function seedSnapshotProductData(sql: postgres.Sql): Promise<void> {
  const dayStart = Date.UTC(2026, 5, 20, 0, 0, 0, 0);
  const priorDay = dayStart - 24 * 60 * 60 * 1000;
  const nextDay = dayStart + 24 * 60 * 60 * 1000;

  await sql`
    INSERT INTO public.user_accounts (
      id, email, name, password_hash, mfa_state, email_verified, language, ai_opt_out, created_at, updated_at
    ) VALUES
      ('u-old', 'old@slugbase.test', 'Old User', 'secret-hash-1', 'not_enrolled', false, 'en', false, ${priorDay}, ${priorDay}),
      ('u-new', 'new@slugbase.test', 'New User', 'secret-hash-2', 'enrolled', true, 'en', false, ${dayStart + 60_000}, ${dayStart + 60_000}),
      ('u-future', 'future@slugbase.test', 'Future User', 'secret-hash-3', 'not_enrolled', true, 'en', false, ${nextDay}, ${nextDay})
  `;

  await sql`
    INSERT INTO public.workspaces (
      id, name, slug, plan, plan_archived, billing_status, billing_period_end, permanent_personal, created_at, updated_at
    ) VALUES
      ('ws-free', 'Free WS', 'free-ws', 'free', false, null, null, false, ${priorDay}, ${priorDay}),
      ('ws-personal', 'Personal WS', 'personal-ws', 'personal', false, 'active', null, false, ${priorDay}, ${priorDay}),
      ('ws-supporter', 'Supporter WS', 'supporter-ws', 'free', false, null, null, true, ${priorDay}, ${priorDay}),
      ('ws-team', 'Team WS', 'team-ws', 'team', false, 'trialing', null, false, ${dayStart + 60_000}, ${dayStart + 60_000}),
      ('ws-canceled', 'Canceled WS', 'canceled-ws', 'personal', false, 'canceled', null, false, ${priorDay}, ${priorDay})
  `;

  await sql`
    INSERT INTO public.workspace_members (id, workspace_id, user_id, role, joined_at) VALUES
      ('m-1', 'ws-free', 'u-old', 'OWNER', ${priorDay}),
      ('m-2', 'ws-personal', 'u-old', 'OWNER', ${priorDay}),
      ('m-3', 'ws-team', 'u-new', 'OWNER', ${dayStart + 60_000})
  `;

  await sql`
    INSERT INTO public.bookmarks (
      id, workspace_id, user_id, title, url, plan_archived, access_count, created_at, updated_at
    ) VALUES
      ('b-active', 'ws-free', 'u-old', 'Active', 'https://example.com/active', false, 1, ${priorDay}, ${priorDay}),
      ('b-archived', 'ws-team', 'u-new', 'Archived', 'https://example.com/archived', true, 0, ${dayStart + 60_000}, ${dayStart + 60_000}),
      ('b-future', 'ws-team', 'u-future', 'Future', 'https://example.com/future', false, 0, ${nextDay}, ${nextDay})
  `;

  await sql`
    INSERT INTO public.billing_webhook_events (event_id, event_type, processed_at) VALUES
      ('evt-old', 'invoice.paid', ${priorDay}),
      ('evt-day', 'customer.subscription.updated', ${dayStart + 60_000}),
      ('evt-future', 'invoice.paid', ${nextDay})
  `;
}

function extractSessionCookie(response: Response): string {
  const setCookie = response.headers.getSetCookie();
  const cookie = setCookie.find((value) => value.startsWith("slb_admin_session="));
  if (!cookie) {
    throw new Error("Missing slb_admin_session cookie");
  }
  return cookie.split(";")[0] ?? "";
}

describe("snapshot job (integration)", () => {
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
    await ensureWorkspaceMembersTable(sql);
  });

  beforeEach(async () => {
    resetAdminConfigCache();
    await adminDb.sql`TRUNCATE TABLE admin.daily_snapshots, admin.audit_events, admin.admin_sessions, admin.admin_invites, admin.admin_users RESTART IDENTITY CASCADE`;
    await resetPublicProductTables(sql);
    await sql`TRUNCATE TABLE public.workspace_members RESTART IDENTITY CASCADE`;
    await bootstrapAdminIfNeeded(adminDb, config);
    await seedSnapshotProductData(sql);
  });

  afterAll(async () => {
    await adminDb.close();
    await sql.end({ timeout: 5 });
  });

  it("upserts a daily snapshot idempotently for the requested UTC date", async () => {
    const snapshotJob = createSnapshotJob(adminDb, config.DATABASE_URL);

    const first = await snapshotJob.run(SNAPSHOT_DATE);
    expect(first).toEqual({
      snapshotDate: SNAPSHOT_DATE,
      totalAccounts: 2,
      newAccounts: 1,
      verifiedAccounts: 1,
      mfaEnrolledAccounts: 1,
      totalWorkspaces: 5,
      newWorkspaces: 1,
      workspacesByPlan: { free: 1, personal: 3, team: 1 },
      totalBookmarks: 2,
      planArchivedBookmarks: 1,
      totalMemberships: 3,
      activeSubscriptions: 3,
      processedWebhookEvents: 3,
    });

    const second = await snapshotJob.run(SNAPSHOT_DATE);
    expect(second).toEqual(first);

    const rows = await adminDb.db
      .select()
      .from(dailySnapshots)
      .where(eq(dailySnapshots.snapshotDate, SNAPSHOT_DATE));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activeSubscriptions).toBe(3);
    expect(rows[0]?.workspacesByPlan).toEqual({
      free: 1,
      personal: 3,
      team: 1,
    });
    expect(rows[0]?.processedWebhookEvents).toBe(3);
  });

  it("exposes POST /api/internal/snapshot to platform admins only", async () => {
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

    const snapshotResponse = await app.request("/api/internal/snapshot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ snapshotDate: SNAPSHOT_DATE }),
    });

    expect(snapshotResponse.status).toBe(200);
    await expect(snapshotResponse.json()).resolves.toEqual({
      snapshot: expect.objectContaining({
        snapshotDate: SNAPSHOT_DATE,
        activeSubscriptions: 3,
        processedWebhookEvents: 3,
      }),
    });
  });

  it("returns 401 without a session and 403 for non-platform-admin roles", async () => {
    const app = createApp({ isProduction: true, adminDb, config });
    const mail = new RecordingMailService();
    const inviteService = new AdminInviteService(adminDb, config, undefined, mail);

    const unauthenticated = await app.request("/api/internal/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotDate: SNAPSHOT_DATE }),
    });
    expect(unauthenticated.status).toBe(401);

    const platformLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bootstrap@slugbase.test",
        password: "bootstrap-password-12",
      }),
    });
    const platformCookie = extractSessionCookie(platformLogin);

    const inviterRows = await adminDb.db.select().from(adminUsers).limit(1);
    const inviterId = inviterRows[0]?.id;
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

    const forbidden = await app.request("/api/internal/snapshot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie,
      },
      body: JSON.stringify({ snapshotDate: SNAPSHOT_DATE }),
    });
    expect(forbidden.status).toBe(403);
    expect(platformCookie).toContain("slb_admin_session=");
  });

  it("purges daily snapshots older than 400 days", async () => {
    await adminDb.db.insert(dailySnapshots).values({
      snapshotDate: "2024-01-01",
      totalAccounts: 1,
      newAccounts: 0,
      verifiedAccounts: 0,
      mfaEnrolledAccounts: 0,
      totalWorkspaces: 0,
      newWorkspaces: 0,
      workspacesByPlan: { free: 0, personal: 0, team: 0 },
      totalBookmarks: 0,
      planArchivedBookmarks: 0,
      totalMemberships: 0,
      activeSubscriptions: 0,
      processedWebhookEvents: 0,
    });

    const retentionJob = new RetentionJob(adminDb);
    const deleted = await retentionJob.run(new Date(Date.UTC(2026, 5, 21, 3, 0, 0)));
    expect(deleted).toBe(1);

    const remaining = await adminDb.db.select().from(dailySnapshots);
    expect(remaining).toHaveLength(0);
  });
});
