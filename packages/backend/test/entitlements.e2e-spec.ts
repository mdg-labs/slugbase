import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { AuditService } from "../src/audit/audit.service.js";
import { BookmarksService } from "../src/bookmarks/bookmarks.service.js";
import { InvitationsService } from "../src/invitations/invitations.service.js";
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
  describe("CE noop billing - full entitlements", () => {
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
