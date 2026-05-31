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
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("Tenant resolution (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let ownerUserId: string;
  let workspaceId: string;
  let secondWorkspaceId: string;

  const OWNER_EMAIL = "tenant-owner@example.com";
  const OUTSIDER_EMAIL = "tenant-outsider@example.com";
  const PASSWORD = "tenant-test-password-abc-123";

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
    const workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: OWNER_EMAIL,
      name: "Tenant Owner",
      password: PASSWORD,
    });
    ownerUserId = owner.id;

    await accountsService.registerAccount({
      email: OUTSIDER_EMAIL,
      name: "Tenant Outsider",
      password: PASSWORD,
    });

    const ws = await workspacesService.createWorkspace(
      { name: "Owner Workspace", slug: "owner-ws" },
      ownerUserId,
    );
    workspaceId = ws.id;

    const ws2 = await workspacesService.createWorkspace(
      { name: "Second Workspace", slug: "second-ws" },
      ownerUserId,
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

  describe("GET /workspaces/active — before activation", () => {
    it("returns 403 when no active workspace is set", async () => {
      const sessionCookie = await loginAs(OWNER_EMAIL);
      const res = await request(server())
        .get("/workspaces/active")
        .set("Cookie", sessionCookie);
      expect(res.status).toBe(403);
    });

    it("returns 401 without a session cookie", async () => {
      const res = await request(server()).get("/workspaces/active");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /workspaces/:id/activate", () => {
    let sessionCookie: string;
    let csrfToken: string;
    let csrfCookie: string;

    beforeAll(async () => {
      sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);
      csrfToken = csrf.token;
      csrfCookie = csrf.cookie;
    });

    it("activates the workspace and returns workspace metadata", async () => {
      const res = await request(server())
        .post(`/workspaces/${workspaceId}/activate`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send();

      expect(res.status).toBe(200);
      const body = res.body as { id: string; name: string; slug: string };
      expect(body.id).toBe(workspaceId);
      expect(body.name).toBe("Owner Workspace");
      expect(body.slug).toBe("owner-ws");
    });

    it("returns 403 when user is not a member of the target workspace", async () => {
      const outsiderCookie = await loginAs(OUTSIDER_EMAIL);
      const outsiderCsrf = await fetchCsrfToken(outsiderCookie);

      const res = await request(server())
        .post(`/workspaces/${workspaceId}/activate`)
        .set("Cookie", `${outsiderCookie}; ${outsiderCsrf.cookie}`)
        .set("x-csrf-token", outsiderCsrf.token)
        .send();

      expect(res.status).toBe(403);
    });

    it("returns 401 without a session cookie (CSRF present, no session)", async () => {
      // GET /auth/csrf-token requires no session — obtains a bare CSRF token
      const csrfRes = await request(server()).get("/auth/csrf-token");
      const csrfBody = csrfRes.body as { csrfToken: string };
      const csrfCookies = (csrfRes.headers["set-cookie"] as string[] | string | undefined) ?? [];
      const csrfJar = Array.isArray(csrfCookies) ? csrfCookies : [csrfCookies];
      const bareCsrfCookie = csrfJar.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";

      const res = await request(server())
        .post(`/workspaces/${workspaceId}/activate`)
        .set("Cookie", bareCsrfCookie)
        .set("x-csrf-token", csrfBody.csrfToken)
        .send();
      expect(res.status).toBe(401);
    });

    it("returns 403 without CSRF token (CSRF guard)", async () => {
      const res = await request(server())
        .post(`/workspaces/${workspaceId}/activate`)
        .set("Cookie", sessionCookie)
        .send();
      expect(res.status).toBe(403);
    });
  });

  describe("GET /workspaces/active — after activation", () => {
    let sessionCookie: string;
    let csrfToken: string;
    let csrfCookie: string;

    beforeAll(async () => {
      sessionCookie = await loginAs(OWNER_EMAIL);
      const csrf = await fetchCsrfToken(sessionCookie);
      csrfToken = csrf.token;
      csrfCookie = csrf.cookie;

      await request(server())
        .post(`/workspaces/${workspaceId}/activate`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send();
    });

    it("returns the active workspace after activation", async () => {
      const res = await request(server())
        .get("/workspaces/active")
        .set("Cookie", sessionCookie);
      expect(res.status).toBe(200);
      const body = res.body as { id: string };
      expect(body.id).toBe(workspaceId);
    });

    it("switches to a different workspace", async () => {
      await request(server())
        .post(`/workspaces/${secondWorkspaceId}/activate`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send();

      const res = await request(server())
        .get("/workspaces/active")
        .set("Cookie", sessionCookie);
      expect(res.status).toBe(200);
      const body = res.body as { id: string };
      expect(body.id).toBe(secondWorkspaceId);
    });
  });
});
