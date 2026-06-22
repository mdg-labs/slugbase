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

  describe("operator-managed SMTP (workspace mail settings removed)", () => {
    it("returns 404 for GET /workspace/settings/mail", async () => {
      const res = await request(server())
        .get("/workspace/settings/mail")
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(404);
    });

    it("returns 404 for PATCH /workspace/settings/mail", async () => {
      const res = await request(server())
        .patch("/workspace/settings/mail")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ host: "smtp.test.com" });

      expect(res.status).toBe(404);
    });

    it("returns 404 for POST /workspace/settings/mail/test", async () => {
      const res = await request(server())
        .post("/workspace/settings/mail/test")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ to: "admin@example.com" });

      expect(res.status).toBe(404);
    });

    it("returns 404 for GET without session (no auth surface leak)", async () => {
      const res = await request(server()).get("/workspace/settings/mail");
      expect(res.status).toBe(404);
    });

    it("returns 404 for MEMBER (endpoints no longer exist)", async () => {
      const res = await request(server())
        .get("/workspace/settings/mail")
        .set("Cookie", memberSessionCookie);

      expect(res.status).toBe(404);
    });
  });
});
