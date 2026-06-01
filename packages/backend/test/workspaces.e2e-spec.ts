import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
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

    it("cannot delete last workspace (safeguard)", async () => {
      await expect(
        workspacesService.deleteWorkspace(workspaceId, ownerUserId),
      ).rejects.toThrow("last workspace");
    });

    it("deletes the workspace once owner has another workspace", async () => {
      const second = await workspacesService.createWorkspace(
        { name: "Second WS", slug: "second-ws-svc" },
        ownerUserId,
      );
      await workspacesService.deleteWorkspace(workspaceId, ownerUserId);
      await expect(workspacesService.getWorkspace(workspaceId)).rejects.toThrow("not found");
      // clean up second workspace (it is the last one now, so skip delete)
      void second;
    });
  });
});

describe("Workspaces HTTP endpoints (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let workspacesService: WorkspacesService;
  let firstWorkspaceId: string;
  let secondWorkspaceId: string;

  const OWNER_EMAIL = "ws-http-owner@example.com";
  const PASSWORD = "ws-http-password-abc-123";

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: OWNER_EMAIL,
      name: "WS HTTP Owner",
      password: PASSWORD,
    });

    const ws = await workspacesService.createWorkspace(
      { name: "First Workspace", slug: "first-ws-http" },
      owner.id,
    );
    firstWorkspaceId = ws.id;

    const ws2 = await workspacesService.createWorkspace(
      { name: "Second Workspace", slug: "second-ws-http" },
      owner.id,
    );
    secondWorkspaceId = ws2.id;
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

  async function loginAs(email: string): Promise<string> {
    const res = await request(server())
      .post("/auth/login")
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookies = (res.headers["set-cookie"] as string[] | string | undefined) ?? [];
    const jar = Array.isArray(cookies) ? cookies : [cookies];
    const sessionCookieStr = jar.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
    expect(sessionCookieStr).toBeTruthy();
    return sessionCookieStr ?? "";
  }

  async function fetchCsrfToken(
    sessionCookie: string,
  ): Promise<{ token: string; cookie: string }> {
    const res = await request(server())
      .get("/auth/csrf-token")
      .set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
    const body = res.body as { csrfToken: string };
    const cookies = (res.headers["set-cookie"] as string[] | string | undefined) ?? [];
    const jar = Array.isArray(cookies) ? cookies : [cookies];
    const csrfCookieStr = jar.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
    return { token: body.csrfToken, cookie: csrfCookieStr };
  }

  describe("GET /workspaces — list user workspaces", () => {
    it("returns 401 without session", async () => {
      const res = await request(server()).get("/workspaces");
      expect(res.status).toBe(401);
    });

    it("returns list of workspaces for authenticated user", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const res = await request(server())
        .get("/workspaces")
        .set("Cookie", sessionCookie);
      expect(res.status).toBe(200);
      const body = res.body as Array<{ id: string }>;
      expect(Array.isArray(body)).toBe(true);
      const ids = body.map((w) => w.id);
      expect(ids).toContain(firstWorkspaceId);
      expect(ids).toContain(secondWorkspaceId);
    });
  });

  describe("POST /workspaces — create workspace", () => {
    it("returns 401 without session", async () => {
      const csrf = await fetchCsrfToken((await loginAs(OWNER_EMAIL)));
      const res = await request(server())
        .post("/workspaces")
        .set("Cookie", csrf.cookie)
        .set("x-csrf-token", csrf.token)
        .send({ name: "No Session WS", slug: "no-session-ws" });
      expect(res.status).toBe(401);
    });

    it("creates a new workspace for authenticated owner", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);
      const res = await request(server())
        .post("/workspaces")
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send({ name: "Created Via HTTP", slug: "created-via-http" });
      expect(res.status).toBe(201);
      const body = res.body as { id: string; name: string; slug: string; plan: string };
      expect(body.name).toBe("Created Via HTTP");
      expect(body.slug).toBe("created-via-http");
      expect(body.plan).toBe("free");
    });

    it("returns 409 for duplicate slug", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);
      const res = await request(server())
        .post("/workspaces")
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send({ name: "Dup Slug", slug: "first-ws-http" });
      expect(res.status).toBe(409);
    });
  });

  describe("PATCH /workspaces/active — rename active workspace", () => {
    it("returns 403 without CSRF token (mutation endpoint)", async () => {
      const res = await request(server())
        .patch("/workspaces/active")
        .send({ name: "No Auth" });
      expect(res.status).toBe(403);
    });

    it("renames the active workspace", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);
      // Explicitly activate the first workspace so TenantGuard can resolve it.
      // Login sets activeWorkspaceId via resolveDefaultActiveWorkspaceId, but we
      // assert the activate response here to surface any session/CSRF failures early.
      const activateRes = await request(server())
        .post(`/workspaces/${firstWorkspaceId}/activate`)
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send();
      expect(activateRes.status).toBe(200);

      const res = await request(server())
        .patch("/workspaces/active")
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send({ name: "Renamed First" });
      expect(res.status).toBe(200);
      const body = res.body as { id: string; name: string };
      expect(body.id).toBe(firstWorkspaceId);
      expect(body.name).toBe("Renamed First");
    });
  });

  describe("DELETE /workspaces/active — delete active workspace", () => {
    it("returns 403 without CSRF token (mutation endpoint)", async () => {
      const res = await request(server()).delete("/workspaces/active");
      expect(res.status).toBe(403);
    });

    it("deletes active workspace when owner has more than one workspace", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);

      // Create a temporary workspace so owner has >1 workspace, then delete it
      const createRes = await request(server())
        .post("/workspaces")
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send({ name: "Temp To Delete", slug: "temp-to-delete-http" });
      expect(createRes.status).toBe(201);
      const created = createRes.body as { id: string };

      // Activate the newly created workspace so TenantGuard resolves it as the
      // active workspace for the subsequent DELETE /workspaces/active call.
      const activateRes = await request(server())
        .post(`/workspaces/${created.id}/activate`)
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send();
      expect(activateRes.status).toBe(200);

      // Delete it via DELETE /workspaces/active
      const deleteRes = await request(server())
        .delete("/workspaces/active")
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send();
      expect(deleteRes.status).toBe(204);
    });
  });

  describe("PATCH /workspaces/:id — update workspace by ID", () => {
    it("updates workspace name by explicit ID", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);

      const res = await request(server())
        .patch(`/workspaces/${secondWorkspaceId}`)
        .set("Cookie", `${sessionCookie}; ${csrf.cookie}`)
        .set("x-csrf-token", csrf.token)
        .send({ name: "Updated Second" });
      expect(res.status).toBe(200);
      const body = res.body as { id: string; name: string };
      expect(body.id).toBe(secondWorkspaceId);
      expect(body.name).toBe("Updated Second");
    });
  });
});
