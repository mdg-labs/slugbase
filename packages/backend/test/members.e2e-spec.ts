import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { SESSION_COOKIE } from "../src/sessions/session-constants.js";
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Members admin HTTP (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;

  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  let workspaceId: string;
  let ownerSessionCookie: string;
  let ownerCsrfToken: string;
  let ownerCsrfCookie: string;
  let memberSessionCookie: string;
  let memberCsrfToken: string;
  let memberCsrfCookie: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);
    const sessions = moduleRef.get(SessionService);

    const owner = await accountsService.registerAccount({
      email: "members-owner@example.com",
      name: "Members Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const admin = await accountsService.registerAccount({
      email: "members-admin@example.com",
      name: "Members Admin",
      password: "password-abc-123",
    });
    adminUserId = admin.id;

    const member = await accountsService.registerAccount({
      email: "members-member@example.com",
      name: "Members Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const workspace = await workspacesService.createWorkspace(
      { name: "Team Workspace", slug: "team-members-ws", plan: "team", planSeats: 8 },
      ownerUserId,
    );
    workspaceId = workspace.id;

    await membersService.addMember(workspaceId, adminUserId, "ADMIN", ownerUserId);
    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);

    const ownerSession = await sessions.createSession({
      userId: ownerUserId,
      data: { activeWorkspaceId: workspaceId },
    });
    ownerSessionCookie = `${SESSION_COOKIE}=${ownerSession.cookieValue}`;

    const memberSession = await sessions.createSession({
      userId: memberUserId,
      data: { activeWorkspaceId: workspaceId },
    });
    memberSessionCookie = `${SESSION_COOKIE}=${memberSession.cookieValue}`;

    const ownerCsrfRes = await request(app.getHttpServer() as Server)
      .get("/auth/csrf-token")
      .set("Cookie", ownerSessionCookie);
    ownerCsrfToken = (ownerCsrfRes.body as { csrfToken: string }).csrfToken;
    ownerCsrfCookie =
      (ownerCsrfRes.headers["set-cookie"] as string[]).find((c) =>
        c.startsWith("csrf_token="),
      )?.split(";")[0] ?? "";

    const memberCsrfRes = await request(app.getHttpServer() as Server)
      .get("/auth/csrf-token")
      .set("Cookie", memberSessionCookie);
    memberCsrfToken = (memberCsrfRes.body as { csrfToken: string }).csrfToken;
    memberCsrfCookie =
      (memberCsrfRes.headers["set-cookie"] as string[]).find((c) =>
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

  describe("GET /members", () => {
    it("returns member profile rows for admins", async () => {
      const res = await request(server())
        .get("/members")
        .set("Cookie", ownerSessionCookie);

      expect(res.status).toBe(200);
      const body = res.body as Array<{ userId: string; role: string; email: string }>;
      expect(body).toHaveLength(3);
      expect(body.some((row) => row.userId === ownerUserId && row.role === "OWNER")).toBe(true);
      expect(body.every((row) => row.email.includes("@"))).toBe(true);
    });

    it("returns 403 for plain members", async () => {
      const res = await request(server())
        .get("/members")
        .set("Cookie", memberSessionCookie);

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /members/:userId", () => {
    it("allows owner to promote a member to admin", async () => {
      const res = await request(server())
        .patch(`/members/${memberUserId}`)
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ role: "ADMIN" });

      expect(res.status).toBe(200);
      expect((res.body as { role: string }).role).toBe("ADMIN");
    });

    it("returns 403 when a member tries to change roles", async () => {
      const res = await request(server())
        .patch(`/members/${adminUserId}`)
        .set("Cookie", `${memberSessionCookie}; ${memberCsrfCookie}`)
        .set("x-csrf-token", memberCsrfToken)
        .send({ role: "MEMBER" });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /members/transfer-ownership", () => {
    it("transfers ownership to another member", async () => {
      const res = await request(server())
        .post("/members/transfer-ownership")
        .set("Cookie", `${ownerSessionCookie}; ${ownerCsrfCookie}`)
        .set("x-csrf-token", ownerCsrfToken)
        .send({ targetUserId: adminUserId });

      expect(res.status).toBe(200);
      const body = res.body as Array<{ userId: string; role: string }>;
      expect(body.find((row) => row.userId === adminUserId)?.role).toBe("OWNER");
      expect(body.find((row) => row.userId === ownerUserId)?.role).toBe("ADMIN");
    });
  });
});
