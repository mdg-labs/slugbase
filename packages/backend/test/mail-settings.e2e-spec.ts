import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { SESSION_COOKIE } from "../src/sessions/session-constants.js";
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Workspace mail settings HTTP (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  let adminSessionCookie: string;
  let adminCsrfToken: string;
  let adminCsrfCookie: string;
  let memberSessionCookie: string;
  let memberCsrfToken: string;
  let memberCsrfCookie: string;

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
    const workspacesService = moduleRef.get(WorkspacesService);
    const membersService = moduleRef.get(WorkspaceMembersService);
    const sessions = moduleRef.get(SessionService);

    const adminUser = await accountsService.registerAccount({
      email: "mail-settings-admin@example.com",
      name: "Mail Settings Admin",
      password: "password-abc-123",
    });

    const memberUser = await accountsService.registerAccount({
      email: "mail-settings-member@example.com",
      name: "Mail Settings Member",
      password: "password-abc-123",
    });

    const workspace = await workspacesService.createWorkspace(
      { name: "Mail Settings WS", slug: "mail-settings-ws", plan: "free" },
      adminUser.id,
    );

    await membersService.addMember(workspace.id, memberUser.id, "MEMBER", adminUser.id);

    const adminSession = await sessions.createSession({
      userId: adminUser.id,
      data: { activeWorkspaceId: workspace.id },
    });
    adminSessionCookie = `${SESSION_COOKIE}=${adminSession.cookieValue}`;

    const memberSession = await sessions.createSession({
      userId: memberUser.id,
      data: { activeWorkspaceId: workspace.id },
    });
    memberSessionCookie = `${SESSION_COOKIE}=${memberSession.cookieValue}`;

    const adminCsrfRes = await request(app.getHttpServer() as Server)
      .get("/auth/csrf-token")
      .set("Cookie", adminSessionCookie);
    adminCsrfToken = (adminCsrfRes.body as { csrfToken: string }).csrfToken;
    adminCsrfCookie =
      (adminCsrfRes.headers["set-cookie"] as string[]).find((c) =>
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

  describe("GET /workspace/settings/mail", () => {
    it("returns 200 with default settings for ADMIN", async () => {
      const res = await request(server())
        .get("/workspace/settings/mail")
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty("host");
      expect(body).toHaveProperty("port");
      expect(body).toHaveProperty("secure");
      expect(body).toHaveProperty("user");
      expect(body).toHaveProperty("hasPassword");
      expect(body).toHaveProperty("from");
      expect(body).not.toHaveProperty("encryptedPass");
      expect(body).not.toHaveProperty("password");
    });

    it("returns 403 for MEMBER", async () => {
      const res = await request(server())
        .get("/workspace/settings/mail")
        .set("Cookie", memberSessionCookie);

      expect(res.status).toBe(403);
    });

    it("returns 401 without session", async () => {
      const res = await request(server()).get("/workspace/settings/mail");
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /workspace/settings/mail", () => {
    it("updates settings and returns them for ADMIN", async () => {
      const res = await request(server())
        .patch("/workspace/settings/mail")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ host: "smtp.test.com", port: 587, secure: false, from: "test@example.com" });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.host).toBe("smtp.test.com");
      expect(body.port).toBe(587);
      expect(body.from).toBe("test@example.com");
      expect(body).not.toHaveProperty("encryptedPass");
    });

    it("stores password as encrypted (hasPassword=true after setting)", async () => {
      const res = await request(server())
        .patch("/workspace/settings/mail")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ password: "s3cr3t-smtp-pass" });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.hasPassword).toBe(true);
      expect(body).not.toHaveProperty("password");
      expect(body).not.toHaveProperty("encryptedPass");
    });

    it("returns 403 for MEMBER", async () => {
      const res = await request(server())
        .patch("/workspace/settings/mail")
        .set("Cookie", `${memberSessionCookie}; ${memberCsrfCookie}`)
        .set("x-csrf-token", memberCsrfToken)
        .send({ host: "smtp.test.com" });

      expect(res.status).toBe(403);
    });

    it("returns 403 without CSRF token", async () => {
      const res = await request(server())
        .patch("/workspace/settings/mail")
        .set("Cookie", adminSessionCookie)
        .send({ host: "smtp.test.com" });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /workspace/settings/mail/test", () => {
    it("returns 503 when mail transport is not configured (noop in test env)", async () => {
      const res = await request(server())
        .post("/workspace/settings/mail/test")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ to: "admin@example.com" });

      expect(res.status).toBe(503);
    });

    it("returns 403 for MEMBER", async () => {
      const res = await request(server())
        .post("/workspace/settings/mail/test")
        .set("Cookie", `${memberSessionCookie}; ${memberCsrfCookie}`)
        .set("x-csrf-token", memberCsrfToken)
        .send({ to: "admin@example.com" });

      expect(res.status).toBe(403);
    });

    it("returns 403 without CSRF token", async () => {
      const res = await request(server())
        .post("/workspace/settings/mail/test")
        .set("Cookie", adminSessionCookie)
        .send({ to: "admin@example.com" });

      expect(res.status).toBe(403);
    });
  });
});
