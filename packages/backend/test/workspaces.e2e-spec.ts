import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("Workspaces (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;
  let ownerUserId: string;
  let memberUserId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "ws-owner@example.com",
      name: "WS Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "ws-member@example.com",
      name: "WS Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  describe("create workspace → creator is OWNER", () => {
    let workspaceId: string;

    it("creates a workspace and auto-assigns creator as OWNER", async () => {
      const workspace = await workspacesService.createWorkspace(
        { name: "My Workspace", slug: "my-workspace" },
        ownerUserId,
      );
      expect(workspace.id).toBeTruthy();
      expect(workspace.name).toBe("My Workspace");
      expect(workspace.slug).toBe("my-workspace");
      expect(workspace.plan).toBe("free");
      expect(workspace.planArchived).toBe(false);
      workspaceId = workspace.id;

      const ownerMember = await membersService.getMember(workspaceId, ownerUserId);
      expect(ownerMember.role).toBe("OWNER");
    });

    it("rejects a duplicate slug", async () => {
      await expect(
        workspacesService.createWorkspace(
          { name: "Duplicate", slug: "my-workspace" },
          ownerUserId,
        ),
      ).rejects.toThrow("already exists");
    });

    it("adds a MEMBER to the workspace", async () => {
      const member = await membersService.addMember(
        workspaceId,
        memberUserId,
        "MEMBER",
        ownerUserId,
      );
      expect(member.role).toBe("MEMBER");
      expect(member.userId).toBe(memberUserId);
    });

    it("lists members and finds both OWNER and MEMBER", async () => {
      const members = await membersService.listMembers(workspaceId);
      expect(members).toHaveLength(2);
      const roles = members.map((m) => m.role);
      expect(roles).toContain("OWNER");
      expect(roles).toContain("MEMBER");
    });

    it("getMember returns the correct role", async () => {
      const memberRecord = await membersService.getMember(workspaceId, memberUserId);
      expect(memberRecord.role).toBe("MEMBER");
    });

    it("listUserWorkspaces includes the workspace for both users", async () => {
      const ownerWorkspaces = await workspacesService.listUserWorkspaces(ownerUserId);
      expect(ownerWorkspaces.some((w) => w.id === workspaceId)).toBe(true);

      const memberWorkspaces = await workspacesService.listUserWorkspaces(memberUserId);
      expect(memberWorkspaces.some((w) => w.id === workspaceId)).toBe(true);
    });

    it("MEMBER cannot remove OWNER", async () => {
      await expect(
        membersService.removeMember(workspaceId, ownerUserId, memberUserId),
      ).rejects.toThrow();
    });

    it("removes MEMBER from the workspace", async () => {
      await membersService.removeMember(workspaceId, memberUserId, ownerUserId);
      const members = await membersService.listMembers(workspaceId);
      expect(members.some((m) => m.userId === memberUserId)).toBe(false);
    });

    it("cannot remove the last OWNER", async () => {
      await expect(
        membersService.removeMember(workspaceId, ownerUserId, ownerUserId),
      ).rejects.toThrow("last owner");
    });

    it("OWNER can update workspace settings", async () => {
      const updated = await workspacesService.updateWorkspace(
        workspaceId,
        { name: "Updated Workspace" },
        ownerUserId,
      );
      expect(updated.name).toBe("Updated Workspace");
    });

    it("deletes the workspace (OWNER only)", async () => {
      await workspacesService.deleteWorkspace(workspaceId, ownerUserId);
      await expect(workspacesService.getWorkspace(workspaceId)).rejects.toThrow(
        "not found",
      );
    });
  });
});
