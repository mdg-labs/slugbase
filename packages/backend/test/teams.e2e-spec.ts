import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { TeamsService } from "../src/teams/teams.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Teams (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let teamsService: TeamsService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;

  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let workspaceId: string;
  let workspace: Awaited<ReturnType<WorkspacesService["getWorkspace"]>>;

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
    teamsService = moduleRef.get(TeamsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const owner = await accountsService.registerAccount({
      email: "team-owner@example.com",
      name: "Team Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const admin = await accountsService.registerAccount({
      email: "team-admin@example.com",
      name: "Team Admin",
      password: "password-abc-123",
    });
    adminUserId = admin.id;

    const member = await accountsService.registerAccount({
      email: "team-member@example.com",
      name: "Team Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const outsider = await accountsService.registerAccount({
      email: "team-outsider@example.com",
      name: "Team Outsider",
      password: "password-abc-123",
    });
    outsiderUserId = outsider.id;

    const ws = await workspacesService.createWorkspace(
      { name: "Team Workspace", slug: "team-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;
    workspace = ws;

    await membersService.addMember(workspaceId, adminUserId, "ADMIN", ownerUserId);
    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  describe("CRUD + admin authorization", () => {
    let teamId: string;

    it("creates a team with name and description", async () => {
      const team = await teamsService.createTeam(workspace, ownerUserId, {
        name: "Engineering",
        description: "Core product team",
        memberIds: [ownerUserId, memberUserId],
      });

      expect(team.id).toBeTruthy();
      expect(team.workspaceId).toBe(workspaceId);
      expect(team.name).toBe("Engineering");
      expect(team.description).toBe("Core product team");
      expect(team.memberCount).toBe(2);
      expect(team.memberIds.sort()).toEqual([ownerUserId, memberUserId].sort());
      teamId = team.id;
    });

    it("allows workspace admins to create teams", async () => {
      const team = await teamsService.createTeam(workspace, adminUserId, {
        name: "Design",
      });
      expect(team.name).toBe("Design");
    });

    it("rejects team creation by regular members", async () => {
      await expect(
        teamsService.createTeam(workspace, memberUserId, { name: "Blocked" }),
      ).rejects.toThrow("Insufficient role");
    });

    it("lists teams for any workspace member", async () => {
      const ownerPage = await teamsService.listTeams(workspace, {
        q: "Engineering",
        sort: "name-asc",
        page: 1,
        pageSize: 10,
      });

      expect(ownerPage.total).toBeGreaterThanOrEqual(1);
      expect(ownerPage.items.some((t) => t.id === teamId)).toBe(true);

      const memberPage = await teamsService.listTeams(workspace, {
        page: 1,
        pageSize: 50,
      });
      expect(memberPage.items.some((t) => t.id === teamId)).toBe(true);
    });

    it("reads a team for any workspace member", async () => {
      const team = await teamsService.getTeam(workspace, teamId);
      expect(team.id).toBe(teamId);

      const memberView = await teamsService.getTeam(workspace, teamId);
      expect(memberView.id).toBe(teamId);
    });

    it("updates team fields", async () => {
      const updated = await teamsService.updateTeam(workspace, ownerUserId, teamId, {
        name: "Platform Engineering",
        description: "Updated description",
      });
      expect(updated.name).toBe("Platform Engineering");
      expect(updated.description).toBe("Updated description");
    });

    it("rejects update by regular members", async () => {
      await expect(
        teamsService.updateTeam(workspace, memberUserId, teamId, {
          name: "Hijacked",
        }),
      ).rejects.toThrow("Insufficient role");
    });

    it("deletes the team", async () => {
      await teamsService.deleteTeam(workspace, ownerUserId, teamId);
      await expect(teamsService.getTeam(workspace, teamId)).rejects.toThrow(
        "Team not found",
      );
    });
  });

  describe("membership management", () => {
    let teamId: string;

    beforeAll(async () => {
      const team = await teamsService.createTeam(workspace, ownerUserId, {
        name: "Membership Team",
      });
      teamId = team.id;
    });

    it("adds a workspace member to a team", async () => {
      const updated = await teamsService.addTeamMember(
        workspace,
        ownerUserId,
        teamId,
        memberUserId,
      );
      expect(updated.memberIds).toContain(memberUserId);
      expect(updated.memberCount).toBe(1);
    });

    it("rejects adding a non-workspace member", async () => {
      await expect(
        teamsService.addTeamMember(workspace, ownerUserId, teamId, outsiderUserId),
      ).rejects.toThrow("User is not a workspace member");
    });

    it("replaces team membership set", async () => {
      const updated = await teamsService.setTeamMembers(
        workspace,
        ownerUserId,
        teamId,
        [adminUserId, memberUserId],
      );
      expect(updated.memberIds.sort()).toEqual([adminUserId, memberUserId].sort());
      expect(updated.memberCount).toBe(2);
    });

    it("removes a member from a team", async () => {
      const updated = await teamsService.removeTeamMember(
        workspace,
        ownerUserId,
        teamId,
        memberUserId,
      );
      expect(updated.memberIds).not.toContain(memberUserId);
      expect(updated.memberCount).toBe(1);
    });

    it("rejects membership changes by regular members", async () => {
      await expect(
        teamsService.addTeamMember(workspace, memberUserId, teamId, adminUserId),
      ).rejects.toThrow("Insufficient role");
    });
  });
});
