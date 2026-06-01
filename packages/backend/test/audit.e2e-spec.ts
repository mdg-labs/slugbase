import "reflect-metadata";

import { ForbiddenException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { AuditActions } from "../src/audit/audit.actions.js";
import { AuditService } from "../src/audit/audit.service.js";
import { SESSION_COOKIE } from "../src/sessions/session-constants.js";
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { TeamsService } from "../src/teams/teams.service.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

interface AuditEventsResponse {
  items: Array<{
    entityType: string;
    actorUserId: string;
    action: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

interface ErrorResponse {
  message: string;
}

describe("Audit log (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let auditService: AuditService;
  let teamsService: TeamsService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;

  let ownerUserId: string;
  let memberUserId: string;
  let teamWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;
  let freeWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;
  let ownerSessionCookie: string;
  let ownerCsrfToken: string;
  let ownerCsrfCookie: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_hosted_plan_gating",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    auditService = moduleRef.get(AuditService);
    teamsService = moduleRef.get(TeamsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);
    const sessions = moduleRef.get(SessionService);

    const owner = await accountsService.registerAccount({
      email: "audit-owner@example.com",
      name: "Audit Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "audit-member@example.com",
      name: "Audit Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    teamWorkspace = await workspacesService.createWorkspace(
      { name: "Team Audit Workspace", slug: "team-audit-ws", plan: "team" },
      ownerUserId,
    );

    freeWorkspace = await workspacesService.createWorkspace(
      { name: "Free Audit Workspace", slug: "free-audit-ws", plan: "free" },
      ownerUserId,
    );

    await membersService.addMember(
      teamWorkspace.id,
      memberUserId,
      "MEMBER",
      ownerUserId,
    );

    const { cookieValue } = await sessions.createSession({
      userId: ownerUserId,
      data: { activeWorkspaceId: teamWorkspace.id },
    });
    ownerSessionCookie = `${SESSION_COOKIE}=${cookieValue}`;

    const csrfRes = await request(app.getHttpServer() as Server)
      .get("/auth/csrf-token")
      .set("Cookie", ownerSessionCookie);

    const csrfBody = csrfRes.body as { csrfToken: string };
    ownerCsrfToken = csrfBody.csrfToken;
    const setCookieHeader = csrfRes.headers["set-cookie"] as
      | string[]
      | string
      | undefined;
    const csrfCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    ownerCsrfCookie =
      csrfCookies.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  function server(): Server {
    if (!app) throw new Error("app not initialized");
    return app.getHttpServer() as Server;
  }

  describe("recording significant actions", () => {
    it("records team creation in the audit log", async () => {
      const team = await teamsService.createTeam(teamWorkspace, ownerUserId, {
        name: "Platform",
        description: "Infra team",
      });

      const result = await auditService.listEvents(
        teamWorkspace,
        ownerUserId,
        {},
      );

      const match = result.items.find(
        (item) =>
          item.action === AuditActions.team.created && item.entityId === team.id,
      );
      expect(match).toBeDefined();
      expect(match?.entityType).toBe("team");
      expect(match?.actorUserId).toBe(ownerUserId);
      expect(match?.actorName).toBe("Audit Owner");
      expect(match?.metadata).toEqual({ name: "Platform" });
    });

    it("records team deletion in the audit log", async () => {
      const team = await teamsService.createTeam(teamWorkspace, ownerUserId, {
        name: "Temporary",
      });
      await teamsService.deleteTeam(teamWorkspace, ownerUserId, team.id);

      const result = await auditService.listEvents(
        teamWorkspace,
        ownerUserId,
        { entityType: "team" },
      );

      const deleted = result.items.find(
        (item) =>
          item.action === AuditActions.team.deleted && item.entityId === team.id,
      );
      expect(deleted).toBeDefined();
      expect(deleted?.metadata).toEqual({ name: "Temporary" });
    });
  });

  describe("read API — pagination and filters", () => {
    it("returns paginated newest-first results", async () => {
      const result = await auditService.listEvents(
        teamWorkspace,
        ownerUserId,
        { page: 1, pageSize: 5 },
      );

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(5);
      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.items.length).toBeLessThanOrEqual(5);

      for (let i = 1; i < result.items.length; i += 1) {
        const newer = result.items[i - 1]?.createdAt.getTime() ?? 0;
        const older = result.items[i]?.createdAt.getTime() ?? 0;
        expect(newer).toBeGreaterThanOrEqual(older);
      }
    });

    it("filters by entity type", async () => {
      const result = await auditService.listEvents(
        teamWorkspace,
        ownerUserId,
        { entityType: "team" },
      );

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((item) => item.entityType === "team")).toBe(true);
    });
  });

  describe("entitlement and role gating", () => {
    it("refuses audit log access on non-Team plans", async () => {
      await expect(
        auditService.listEvents(freeWorkspace, ownerUserId, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it("refuses audit log access for non-admin members on Team plan", async () => {
      await expect(
        auditService.listEvents(teamWorkspace, memberUserId, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it("returns 403 from HTTP endpoint when plan lacks audit-log entitlement", async () => {
      const sessions = app?.get(SessionService);
      if (!sessions) throw new Error("SessionService unavailable");

      const { cookieValue } = await sessions.createSession({
        userId: ownerUserId,
        data: { activeWorkspaceId: freeWorkspace.id },
      });

      const csrfRes = await request(server())
        .get("/auth/csrf-token")
        .set("Cookie", `${SESSION_COOKIE}=${cookieValue}`);

      const csrfBody = csrfRes.body as { csrfToken: string };
      const setCookieHeader = csrfRes.headers["set-cookie"] as
        | string[]
        | string
        | undefined;
      const csrfCookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader
          ? [setCookieHeader]
          : [];
      const csrfCookie =
        csrfCookies.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";

      const response = await request(server())
        .get("/audit/events")
        .set("Cookie", [`${SESSION_COOKIE}=${cookieValue}`, csrfCookie])
        .set("x-csrf-token", csrfBody.csrfToken)
        .expect(403);

      const body = response.body as ErrorResponse;
      expect(body.message).toContain("audit-log");
    });

    it("returns audit events over HTTP for Team plan admins", async () => {
      const response = await request(server())
        .get("/audit/events?entityType=team&pageSize=10")
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .expect(200);

      const body = response.body as AuditEventsResponse;
      expect(body.total).toBeGreaterThan(0);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items[0]).toMatchObject({
        entityType: "team",
        actorUserId: ownerUserId,
      });
    });
  });
});
