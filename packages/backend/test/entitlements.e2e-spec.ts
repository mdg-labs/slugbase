import "reflect-metadata";

import { ForbiddenException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { AuditService } from "../src/audit/audit.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { InvitationsService } from "../src/invitations/invitations.service.js";
import { SESSION_COOKIE } from "../src/sessions/session-constants.js";
import { SessionService } from "../src/sessions/session.service.js";
import { SharingService } from "../src/sharing/sharing.service.js";
import { TeamsService } from "../src/teams/teams.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

async function bootstrapApp(databaseUrl: string, envOverrides: NodeJS.ProcessEnv = {}) {
  applyTestEnv({ DATABASE_URL: databaseUrl, ...envOverrides });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  return { app, moduleRef };
}

describe("Team entitlements (integration)", () => {
  describe("hosted billing - plan gating via Stripe config", () => {
    let app: INestApplication | undefined;
    let cleanup: () => Promise<void> = async () => {};

    let ownerUserId: string;
    let memberUserId: string;
    let freeWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;
    let personalWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;
    let teamWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

    let sharingService: SharingService;
    let teamsService: TeamsService;
    let invitationsService: InvitationsService;
    let auditService: AuditService;
    let bookmarksService: BookmarksService;
    let membersService: WorkspaceMembersService;
    let sessions: SessionService;

    let ownerSessionCookie: string;
    let ownerCsrfToken: string;
    let ownerCsrfCookie: string;

    beforeAll(async () => {
      const testDatabase = await createTestDatabase();
      cleanup = testDatabase.cleanup;

      clearTestEnv();
      const boot = await bootstrapApp(testDatabase.databaseUrl, {
        STRIPE_SECRET_KEY: "sk_test_hosted_plan_gating",
      });
      app = boot.app;

      const accountsService = boot.moduleRef.get(AccountsService);
      sharingService = boot.moduleRef.get(SharingService);
      teamsService = boot.moduleRef.get(TeamsService);
      invitationsService = boot.moduleRef.get(InvitationsService);
      auditService = boot.moduleRef.get(AuditService);
      bookmarksService = boot.moduleRef.get(BookmarksService);
      membersService = boot.moduleRef.get(WorkspaceMembersService);
      sessions = boot.moduleRef.get(SessionService);
      const workspacesService = boot.moduleRef.get(WorkspacesService);

      const owner = await accountsService.registerAccount({
        email: "entitlements-owner@example.com",
        name: "Entitlements Owner",
        password: "password-abc-123",
      });
      ownerUserId = owner.id;

      const member = await accountsService.registerAccount({
        email: "entitlements-member@example.com",
        name: "Entitlements Member",
        password: "password-abc-123",
      });
      memberUserId = member.id;

      freeWorkspace = await workspacesService.createWorkspace(
        { name: "Free Entitlements WS", slug: "free-ent-ws", plan: "free" },
        ownerUserId,
      );
      personalWorkspace = await workspacesService.createWorkspace(
        { name: "Personal Entitlements WS", slug: "personal-ent-ws", plan: "personal" },
        ownerUserId,
      );
      teamWorkspace = await workspacesService.createWorkspace(
        { name: "Team Entitlements WS", slug: "team-ent-ws", plan: "team", planSeats: 10 },
        ownerUserId,
      );

      await membersService.addMember(
        freeWorkspace.id,
        memberUserId,
        "MEMBER",
        ownerUserId,
      );
      await membersService.addMember(
        personalWorkspace.id,
        memberUserId,
        "MEMBER",
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
        data: { activeWorkspaceId: personalWorkspace.id },
      });
      ownerSessionCookie = `${SESSION_COOKIE}=${cookieValue}`;

      const csrfRes = await request(app.getHttpServer() as Server)
        .get("/auth/csrf-token")
        .set("Cookie", ownerSessionCookie);
      ownerCsrfToken = (csrfRes.body as { csrfToken: string }).csrfToken;
      ownerCsrfCookie =
        (csrfRes.headers["set-cookie"] as string[]).find((c) =>
          c.startsWith("csrf_token="),
        )?.split(";")[0] ?? "";
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

    it("refuses team sharing on free and personal plans", async () => {
      const freeBookmark = await bookmarksService.createBookmark(
        freeWorkspace,
        ownerUserId,
        { title: "Free Share", url: "https://free.example.com" },
      );
      const personalBookmark = await bookmarksService.createBookmark(
        personalWorkspace,
        ownerUserId,
        { title: "Personal Share", url: "https://personal.example.com" },
      );

      await expect(
        sharingService.grantBookmarkShare(freeWorkspace, ownerUserId, freeBookmark.id, {
          kind: "user",
          targetId: memberUserId,
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        sharingService.grantBookmarkShare(
          personalWorkspace,
          ownerUserId,
          personalBookmark.id,
          { kind: "user", targetId: memberUserId },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows team sharing on Team plan", async () => {
      const bookmark = await bookmarksService.createBookmark(
        teamWorkspace,
        ownerUserId,
        { title: "Team Share", url: "https://team.example.com" },
      );

      const grant = await sharingService.grantBookmarkShare(
        teamWorkspace,
        ownerUserId,
        bookmark.id,
        { kind: "user", targetId: memberUserId },
      );
      expect(grant.targetId).toBe(memberUserId);
    });

    it("refuses team admin mutations on non-Team plans", async () => {
      await expect(
        teamsService.createTeam(freeWorkspace, ownerUserId, { name: "Blocked Free" }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        teamsService.createTeam(personalWorkspace, ownerUserId, {
          name: "Blocked Personal",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows team admin mutations on Team plan", async () => {
      const team = await teamsService.createTeam(teamWorkspace, ownerUserId, {
        name: "Allowed Team",
      });
      expect(team.name).toBe("Allowed Team");
    });

    it("refuses member invitations on free and personal plans", async () => {
      await expect(
        invitationsService.createInvitation(freeWorkspace.id, ownerUserId, {
          email: "blocked-free@example.com",
          role: "MEMBER",
        }),
      ).rejects.toThrow(ForbiddenException);

      const res = await request(server())
        .post(`/workspaces/${personalWorkspace.id}/invitations`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ email: "blocked-personal@example.com", role: "MEMBER" });

      expect(res.status).toBe(403);
    });

    it("allows member invitations on Team plan", async () => {
      const invitation = await invitationsService.createInvitation(
        teamWorkspace.id,
        ownerUserId,
        { email: "allowed-team@example.com", role: "MEMBER" },
      );
      expect(invitation.invitedEmail).toBe("allowed-team@example.com");
    });

    it("refuses audit log read on non-Team plans", async () => {
      await expect(
        auditService.listEvents(freeWorkspace, ownerUserId, {}),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        auditService.listEvents(personalWorkspace, ownerUserId, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows audit log read on Team plan for admins", async () => {
      const result = await auditService.listEvents(teamWorkspace, ownerUserId, {});
      expect(Array.isArray(result.items)).toBe(true);
    });

    it("allows members list read on personal plan for admins (no team-admin gate)", async () => {
      const { cookieValue } = await sessions.createSession({
        userId: ownerUserId,
        data: { activeWorkspaceId: personalWorkspace.id },
      });

      const csrfRes = await request(server())
        .get("/auth/csrf-token")
        .set("Cookie", `${SESSION_COOKIE}=${cookieValue}`);
      const csrfBody = csrfRes.body as { csrfToken: string };
      const csrfCookie =
        (csrfRes.headers["set-cookie"] as string[]).find((c) =>
          c.startsWith("csrf_token="),
        )?.split(";")[0] ?? "";

      await request(server())
        .get("/members")
        .set("Cookie", [`${SESSION_COOKIE}=${cookieValue}`, csrfCookie])
        .set("x-csrf-token", csrfBody.csrfToken)
        .expect(200);
    });
  });

  describe("self-host billing - full entitlements without Stripe", () => {
    let app: INestApplication | undefined;
    let cleanup: () => Promise<void> = async () => {};

    let ownerUserId: string;
    let memberUserId: string;
    let freeWorkspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

    let sharingService: SharingService;
    let teamsService: TeamsService;
    let invitationsService: InvitationsService;
    let auditService: AuditService;
    let bookmarksService: BookmarksService;
    let membersService: WorkspaceMembersService;

    beforeAll(async () => {
      const testDatabase = await createTestDatabase();
      cleanup = testDatabase.cleanup;

      clearTestEnv();
      const boot = await bootstrapApp(testDatabase.databaseUrl);
      app = boot.app;

      const accountsService = boot.moduleRef.get(AccountsService);
      sharingService = boot.moduleRef.get(SharingService);
      teamsService = boot.moduleRef.get(TeamsService);
      invitationsService = boot.moduleRef.get(InvitationsService);
      auditService = boot.moduleRef.get(AuditService);
      bookmarksService = boot.moduleRef.get(BookmarksService);
      membersService = boot.moduleRef.get(WorkspaceMembersService);
      const workspacesService = boot.moduleRef.get(WorkspacesService);

      const owner = await accountsService.registerAccount({
        email: "selfhost-owner@example.com",
        name: "Self-host Owner",
        password: "password-abc-123",
      });
      ownerUserId = owner.id;

      const member = await accountsService.registerAccount({
        email: "selfhost-member@example.com",
        name: "Self-host Member",
        password: "password-abc-123",
      });
      memberUserId = member.id;

      freeWorkspace = await workspacesService.createWorkspace(
        { name: "Self-host Free WS", slug: "selfhost-free-ws", plan: "free" },
        ownerUserId,
      );

      await membersService.addMember(
        freeWorkspace.id,
        memberUserId,
        "MEMBER",
        ownerUserId,
      );
    });

    afterAll(async () => {
      if (app) await app.close();
      clearTestEnv();
      await cleanup();
    });

    it("allows team sharing on free plan when billing is no-op", async () => {
      const bookmark = await bookmarksService.createBookmark(
        freeWorkspace,
        ownerUserId,
        { title: "Self-host Share", url: "https://selfhost.example.com" },
      );

      const grant = await sharingService.grantBookmarkShare(
        freeWorkspace,
        ownerUserId,
        bookmark.id,
        { kind: "user", targetId: memberUserId },
      );
      expect(grant.targetId).toBe(memberUserId);
    });

    it("allows team admin on free plan when billing is no-op", async () => {
      const team = await teamsService.createTeam(freeWorkspace, ownerUserId, {
        name: "Self-host Team",
      });
      expect(team.name).toBe("Self-host Team");
    });

    it("allows invitations on free plan when billing is no-op", async () => {
      const invitation = await invitationsService.createInvitation(
        freeWorkspace.id,
        ownerUserId,
        { email: "selfhost-invite@example.com", role: "MEMBER" },
      );
      expect(invitation.invitedEmail).toBe("selfhost-invite@example.com");
    });

    it("allows audit log read on free plan when billing is no-op", async () => {
      await teamsService.createTeam(freeWorkspace, ownerUserId, {
        name: "Audit Source Team",
      });

      const result = await auditService.listEvents(freeWorkspace, ownerUserId, {});
      expect(result.total).toBeGreaterThanOrEqual(0);
    });
  });
});
