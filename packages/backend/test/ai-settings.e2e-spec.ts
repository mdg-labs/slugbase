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

describe("Workspace AI settings HTTP (integration)", () => {
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
      email: "ai-settings-admin@example.com",
      name: "AI Settings Admin",
      password: "password-abc-123",
    });

    const memberUser = await accountsService.registerAccount({
      email: "ai-settings-member@example.com",
      name: "AI Settings Member",
      password: "password-abc-123",
    });

    const workspace = await workspacesService.createWorkspace(
      { name: "AI Settings WS", slug: "ai-settings-ws", plan: "free" },
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

  describe("GET /workspace/settings/ai", () => {
    it("returns 200 with default settings for ADMIN", async () => {
      const res = await request(server())
        .get("/workspace/settings/ai")
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty("provider");
      expect(body).toHaveProperty("hasApiKey");
      expect(body).toHaveProperty("model");
      expect(body).toHaveProperty("enabled");
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("encryptedApiKey");
    });

    it("returns 403 for MEMBER", async () => {
      const res = await request(server())
        .get("/workspace/settings/ai")
        .set("Cookie", memberSessionCookie);

      expect(res.status).toBe(403);
    });

    it("returns 401 without session", async () => {
      const res = await request(server()).get("/workspace/settings/ai");
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /workspace/settings/ai", () => {
    it("updates settings and returns them for ADMIN", async () => {
      const res = await request(server())
        .patch("/workspace/settings/ai")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ provider: "openai", model: "gpt-4o-mini", enabled: true });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.provider).toBe("openai");
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.enabled).toBe(true);
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("encryptedApiKey");
    });

    it("stores API key as encrypted (hasApiKey=true after setting)", async () => {
      const res = await request(server())
        .patch("/workspace/settings/ai")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ apiKey: "sk-test-api-key-value" });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.hasApiKey).toBe(true);
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("encryptedApiKey");
    });

    it("returns 403 for MEMBER", async () => {
      const res = await request(server())
        .patch("/workspace/settings/ai")
        .set("Cookie", `${memberSessionCookie}; ${memberCsrfCookie}`)
        .set("x-csrf-token", memberCsrfToken)
        .send({ enabled: true });

      expect(res.status).toBe(403);
    });

    it("returns 403 without CSRF token", async () => {
      const res = await request(server())
        .patch("/workspace/settings/ai")
        .set("Cookie", adminSessionCookie)
        .send({ enabled: true });

      expect(res.status).toBe(403);
    });
  });
});
