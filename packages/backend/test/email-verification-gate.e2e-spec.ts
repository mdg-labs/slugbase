import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MailService } from "@slugbase/shared-types";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { EmailVerificationService } from "../src/auth/verification/email-verification.service.js";
import { MAIL } from "../src/mail/mail.tokens.js";
import { SessionService } from "../src/sessions/session.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

const GATE_PASSWORD = "valid-password-abc-123";
const GATE_NAME = "Gate User";

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

function extractVerifyToken(text: string): string | undefined {
  const match = text.match(/verify-email\?token=([0-9a-f]{64})/);
  return match?.[1];
}

describe("Email verification session gate (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let mailSend: ReturnType<typeof vi.fn>;
  let sessionService: SessionService;
  let verificationService: EmailVerificationService;
  let accountsService: AccountsService;
  let workspacesService: WorkspacesService;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    mailSend = vi.fn().mockResolvedValue(undefined);

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      EMAIL_VERIFICATION_REQUIRED: "true",
      PUBLIC_REGISTRATION: "true",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAIL)
      .useValue({
        isAvailable: () => true,
        ensureAvailable: () => Promise.resolve(true),
        send: mailSend,
        sendTest: vi.fn().mockResolvedValue(undefined),
      } satisfies MailService)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    sessionService = moduleRef.get(SessionService);
    verificationService = moduleRef.get(EmailVerificationService);
    accountsService = moduleRef.get(AccountsService);
    workspacesService = moduleRef.get(WorkspacesService);
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

  async function seedUnverifiedUser(email: string, slug: string) {
    const account = await accountsService.registerAccount({
      email,
      name: GATE_NAME,
      password: GATE_PASSWORD,
    });

    const workspace = await workspacesService.createWorkspace(
      {
        name: `${GATE_NAME}'s workspace`,
        slug,
        plan: "free",
      },
      account.id,
    );

    return { account, workspace };
  }

  it("returns emailVerificationRequired on login for unverified users", async () => {
    await seedUnverifiedUser("gate-login@example.com", "gate-login-ws");

    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: "gate-login@example.com", password: GATE_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toEqual({
      userId: expect.any(String),
      emailVerificationRequired: true,
    });
  });

  it("blocks tenant routes while verification is pending", async () => {
    await seedUnverifiedUser("gate-block@example.com", "gate-block-ws");

    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: "gate-block@example.com", password: GATE_PASSWORD });

    const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const activeRes = await request(server())
      .get("/workspaces/active")
      .set("Cookie", sessionCookie);
    expect(activeRes.status).toBe(403);

    const bookmarksRes = await request(server())
      .get("/bookmarks")
      .set("Cookie", sessionCookie);
    expect(bookmarksRes.status).toBe(403);
  });

  it("allows auth endpoints while verification is pending", async () => {
    await seedUnverifiedUser("gate-allow@example.com", "gate-allow-ws");

    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: "gate-allow@example.com", password: GATE_PASSWORD });

    const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const meRes = await request(server())
      .get("/auth/me")
      .set("Cookie", sessionCookie);
    expect(meRes.status).toBe(200);
    expect(meRes.body).toMatchObject({
      email: "gate-allow@example.com",
      emailVerified: false,
    });

    const resendRes = await request(server())
      .post("/auth/resend-verification")
      .set("Cookie", sessionCookie);
    expect(resendRes.status).toBe(200);

    const logoutRes = await request(server())
      .post("/auth/logout")
      .set("Cookie", sessionCookie);
    expect(logoutRes.status).toBe(200);
  });

  it("grants tenant access after verify-email clears the session gate", async () => {
    mailSend.mockClear();

    const { account, workspace } = await seedUnverifiedUser(
      "gate-verify@example.com",
      "gate-verify-ws",
    );

    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: "gate-verify@example.com", password: GATE_PASSWORD });

    const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    await verificationService.issueToken(account.id, account.email);

    const mailPayload = mailSend.mock.calls[0]?.[0] as { text: string };
    const verifyToken = extractVerifyToken(mailPayload.text);
    expect(verifyToken).toBeDefined();

    const verifyRes = await request(server())
      .get(`/auth/verify-email?token=${verifyToken ?? ""}`)
      .set("Cookie", sessionCookie);
    expect(verifyRes.status).toBe(200);

    const cookieValue = sessionCookie.split("=").slice(1).join("=");
    const sessionId = sessionService.verifySessionCookie(cookieValue);
    expect(sessionId).not.toBeNull();
    if (sessionId) {
      const session = await sessionService.findSession(sessionId);
      expect(session?.data).toMatchObject({
        activeWorkspaceId: workspace.id,
      });
      expect(session?.data).not.toHaveProperty("emailVerificationPending");
    }

    const activeRes = await request(server())
      .get("/workspaces/active")
      .set("Cookie", sessionCookie);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body).toMatchObject({ id: workspace.id });
  });
});

describe("Email verification gate disabled (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      SLUGBASE_EDITION: "ce",
      EMAIL_VERIFICATION_REQUIRED: "false",
      SERVE_WEB_CLIENT: "false",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const accountsService = moduleRef.get(AccountsService);
    const workspacesService = moduleRef.get(WorkspacesService);

    const account = await accountsService.registerAccount({
      email: "ungated@example.com",
      name: "Ungated User",
      password: GATE_PASSWORD,
    });

    await workspacesService.createWorkspace(
      {
        name: "Ungated workspace",
        slug: "ungated-ws",
        plan: "free",
      },
      account.id,
    );
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

  it("allows tenant routes for unverified users when verification is not required", async () => {
    const loginRes = await request(server())
      .post("/auth/login")
      .send({ email: "ungated@example.com", password: GATE_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toEqual({ userId: expect.any(String) });
    expect(loginRes.body).not.toHaveProperty("emailVerificationRequired");

    const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const activeRes = await request(server())
      .get("/workspaces/active")
      .set("Cookie", sessionCookie);
    expect(activeRes.status).toBe(200);
  });
});
