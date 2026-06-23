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

const MAIL_STATUS_PATH = "/workspace/settings/mail/status";

describe("Mail transport status HTTP (integration)", () => {
  describe("unconfigured transport", () => {
    let app: INestApplication | undefined;
    let cleanup: () => Promise<void> = async () => {};
    let adminSessionCookie: string;
    let memberSessionCookie: string;

    beforeAll(async () => {
      const testDatabase = await createTestDatabase();
      cleanup = testDatabase.cleanup;

      applyTestEnv({
        DATABASE_URL: testDatabase.databaseUrl,
        STRIPE_SECRET_KEY: "sk_test_mail_status_unconfigured",
      });
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_PORT;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      delete process.env.SMTP_FROM;

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
        email: "mail-status-admin@example.com",
        name: "Mail Status Admin",
        password: "password-abc-123",
      });

      const memberUser = await accountsService.registerAccount({
        email: "mail-status-member@example.com",
        name: "Mail Status Member",
        password: "password-abc-123",
      });

      const workspace = await workspacesService.createWorkspace(
        { name: "Mail Status WS", slug: "mail-status-ws", plan: "team", planSeats: 10 },
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

    it("returns mailTransportAvailable false for workspace admin", async () => {
      const res = await request(server())
        .get(MAIL_STATUS_PATH)
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mailTransportAvailable: false });
      expect(JSON.stringify(res.body)).not.toMatch(/smtp/i);
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });

    it("returns 403 for workspace member", async () => {
      const res = await request(server())
        .get(MAIL_STATUS_PATH)
        .set("Cookie", memberSessionCookie);

      expect(res.status).toBe(403);
    });
  });

  describe("env-configured transport", () => {
    let app: INestApplication | undefined;
    let cleanup: () => Promise<void> = async () => {};
    let adminSessionCookie: string;

    beforeAll(async () => {
      const testDatabase = await createTestDatabase();
      cleanup = testDatabase.cleanup;

      applyTestEnv({
        DATABASE_URL: testDatabase.databaseUrl,
        STRIPE_SECRET_KEY: "sk_test_mail_status_configured",
        SMTP_HOST: "smtp.status.test",
        SMTP_PORT: "587",
        SMTP_SECURE: "false",
        SMTP_USER: "status-user@status.test",
        SMTP_PASS: "status-secret-password",
        SMTP_FROM: "noreply@status.test",
      });

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();

      const accountsService = moduleRef.get(AccountsService);
      const workspacesService = moduleRef.get(WorkspacesService);
      const sessions = moduleRef.get(SessionService);

      const adminUser = await accountsService.registerAccount({
        email: "mail-status-configured@example.com",
        name: "Mail Status Configured Admin",
        password: "password-abc-123",
      });

      const workspace = await workspacesService.createWorkspace(
        { name: "Mail Status Configured WS", slug: "mail-status-configured-ws", plan: "team", planSeats: 10 },
        adminUser.id,
      );

      const adminSession = await sessions.createSession({
        userId: adminUser.id,
        data: { activeWorkspaceId: workspace.id },
      });
      adminSessionCookie = `${SESSION_COOKIE}=${adminSession.cookieValue}`;
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

    it("returns mailTransportAvailable true when SMTP env is configured", async () => {
      const res = await request(server())
        .get(MAIL_STATUS_PATH)
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mailTransportAvailable: true });
      expect(JSON.stringify(res.body)).not.toContain("status-secret-password");
      expect(JSON.stringify(res.body)).not.toContain("smtp.status.test");
    });
  });
});
