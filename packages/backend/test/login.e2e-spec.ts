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
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Login session (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let sessionService: SessionService;

  const LOGIN_EMAIL = "login-ws@example.com";
  const LOGIN_PASSWORD = "valid-password-abc-123";
  const LOGIN_NAME = "Login Workspace User";
  let workspaceId: string;

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

    sessionService = moduleRef.get(SessionService);
    const accountsService = moduleRef.get(AccountsService);
    const workspacesService = moduleRef.get(WorkspacesService);

    const account = await accountsService.registerAccount({
      email: LOGIN_EMAIL,
      name: LOGIN_NAME,
      password: LOGIN_PASSWORD,
    });

    const workspace = await workspacesService.createWorkspace(
      {
        name: `${LOGIN_NAME}'s workspace`,
        slug: "login-ws",
        plan: "free",
      },
      account.id,
    );
    workspaceId = workspace.id;
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

  function extractSessionCookie(
    setCookie: string[] | string | undefined,
  ): string {
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];
    const sessionCookieHeader = cookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(sessionCookieHeader).toBeDefined();
    return sessionCookieHeader?.split(";")[0] ?? "";
  }

  it("sets activeWorkspaceId on login and GET /workspaces/active returns 200", async () => {
    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    expect(loginRes.status).toBe(200);

    const sessionCookie = extractSessionCookie(
      loginRes.headers["set-cookie"],
    );
    const cookieValue = sessionCookie.split("=").slice(1).join("=");
    const sessionId = sessionService.verifySessionCookie(cookieValue);
    expect(sessionId).not.toBeNull();

    if (sessionId) {
      const session = await sessionService.findSession(sessionId);
      expect(session?.data).toMatchObject({ activeWorkspaceId: workspaceId });
    }

    const activeRes = await request(server())
      .get("/workspaces/active")
      .set("Cookie", sessionCookie);

    expect(activeRes.status).toBe(200);
    const body = activeRes.body as { id: string };
    expect(body.id).toBe(workspaceId);
  });

  it("sets activeWorkspaceId for unverified users on login", async () => {
    const moduleRef = app as INestApplication;
    const accountsService = moduleRef.get(AccountsService);
    const workspacesService = moduleRef.get(WorkspacesService);

    const unverifiedEmail = "unverified-login@example.com";
    const account = await accountsService.registerAccount({
      email: unverifiedEmail,
      name: "Unverified User",
      password: LOGIN_PASSWORD,
    });
    const workspace = await workspacesService.createWorkspace(
      {
        name: "Unverified workspace",
        slug: "unverified-ws",
        plan: "free",
      },
      account.id,
    );

    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: unverifiedEmail, password: LOGIN_PASSWORD });

    expect(loginRes.status).toBe(200);

    const sessionCookie = extractSessionCookie(
      loginRes.headers["set-cookie"],
    );
    const cookieValue = sessionCookie.split("=").slice(1).join("=");
    const sessionId = sessionService.verifySessionCookie(cookieValue);
    expect(sessionId).not.toBeNull();

    if (sessionId) {
      const session = await sessionService.findSession(sessionId);
      expect(session?.data).toMatchObject({
        activeWorkspaceId: workspace.id,
        emailVerificationPending: true,
      });
    }
  });

  it("returns 403 when user has no workspace memberships", async () => {
    const moduleRef = app as INestApplication;
    const accountsService = moduleRef.get(AccountsService);

    const orphanEmail = "orphan@example.com";
    await accountsService.registerAccount({
      email: orphanEmail,
      name: "Orphan User",
      password: LOGIN_PASSWORD,
    });

    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: orphanEmail, password: LOGIN_PASSWORD });

    expect(loginRes.status).toBe(403);
  });
});
