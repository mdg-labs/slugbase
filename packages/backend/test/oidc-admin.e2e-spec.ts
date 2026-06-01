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

describe("OIDC provider admin HTTP (integration)", () => {
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
      email: "oidc-admin@example.com",
      name: "OIDC Admin",
      password: "password-abc-123",
    });

    const memberUser = await accountsService.registerAccount({
      email: "oidc-member@example.com",
      name: "OIDC Member",
      password: "password-abc-123",
    });

    const workspace = await workspacesService.createWorkspace(
      { name: "OIDC Admin WS", slug: "oidc-admin-ws", plan: "free" },
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
    const adminCsrfSetCookie = adminCsrfRes.headers["set-cookie"] as string[] | string;
    adminCsrfCookie = Array.isArray(adminCsrfSetCookie)
      ? (adminCsrfSetCookie.find((c) => c.startsWith("csrf_token=")) ?? "")
      : adminCsrfSetCookie ?? "";

    const memberCsrfRes = await request(app.getHttpServer() as Server)
      .get("/auth/csrf-token")
      .set("Cookie", memberSessionCookie);
    memberCsrfToken = (memberCsrfRes.body as { csrfToken: string }).csrfToken;
    const memberCsrfSetCookie = memberCsrfRes.headers["set-cookie"] as string[] | string;
    memberCsrfCookie = Array.isArray(memberCsrfSetCookie)
      ? (memberCsrfSetCookie.find((c) => c.startsWith("csrf_token=")) ?? "")
      : memberCsrfSetCookie ?? "";
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

  describe("GET /workspace/settings/oidc/providers", () => {
    it("returns 200 with empty array for ADMIN when no providers configured", async () => {
      const res = await request(server())
        .get("/workspace/settings/oidc/providers")
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 403 for MEMBER", async () => {
      const res = await request(server())
        .get("/workspace/settings/oidc/providers")
        .set("Cookie", memberSessionCookie);

      expect(res.status).toBe(403);
    });

    it("returns 401 without session", async () => {
      const res = await request(server()).get("/workspace/settings/oidc/providers");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /workspace/settings/oidc/providers", () => {
    let createdProviderId: string;

    it("creates a provider for ADMIN", async () => {
      const res = await request(server())
        .post("/workspace/settings/oidc/providers")
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({
          name: "Test Identity Provider",
          issuerUrl: "https://idp.oidc-test.example.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          scopes: "openid email profile",
          enabled: true,
        });

      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty("id");
      expect(body.name).toBe("Test Identity Provider");
      expect(body.hasClientSecret).toBe(true);
      expect(body).not.toHaveProperty("clientSecret");
      expect(body).not.toHaveProperty("clientSecretEncrypted");
      createdProviderId = body.id as string;
    });

    it("lists the created provider", async () => {
      const res = await request(server())
        .get("/workspace/settings/oidc/providers")
        .set("Cookie", adminSessionCookie);

      expect(res.status).toBe(200);
      const body = res.body as Array<Record<string, unknown>>;
      expect(body.some((p) => p.id === createdProviderId)).toBe(true);
    });

    it("updates the provider (toggle enabled)", async () => {
      const res = await request(server())
        .patch(`/workspace/settings/oidc/providers/${createdProviderId}`)
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.enabled).toBe(false);
      expect(body).not.toHaveProperty("clientSecretEncrypted");
    });

    it("deletes the provider", async () => {
      const res = await request(server())
        .delete(`/workspace/settings/oidc/providers/${createdProviderId}`)
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken);

      expect(res.status).toBe(204);
    });

    it("returns 404 for deleted provider", async () => {
      const res = await request(server())
        .patch(`/workspace/settings/oidc/providers/${createdProviderId}`)
        .set("Cookie", `${adminSessionCookie}; ${adminCsrfCookie}`)
        .set("x-csrf-token", adminCsrfToken)
        .send({ enabled: true });

      expect(res.status).toBe(404);
    });

    it("returns 403 for MEMBER on POST", async () => {
      const res = await request(server())
        .post("/workspace/settings/oidc/providers")
        .set("Cookie", `${memberSessionCookie}; ${memberCsrfCookie}`)
        .set("x-csrf-token", memberCsrfToken)
        .send({
          name: "Unauthorized",
          issuerUrl: "https://idp.example.com",
          clientId: "client",
          clientSecret: "secret",
        });

      expect(res.status).toBe(403);
    });

    it("returns 403 without CSRF token on POST", async () => {
      const res = await request(server())
        .post("/workspace/settings/oidc/providers")
        .set("Cookie", adminSessionCookie)
        .send({
          name: "No CSRF",
          issuerUrl: "https://idp.example.com",
          clientId: "client",
          clientSecret: "secret",
        });

      expect(res.status).toBe(403);
    });
  });
});
