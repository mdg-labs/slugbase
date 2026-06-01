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
import { MAIL } from "../src/mail/mail.tokens.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

const TYPO_EMAIL = "typo-user@example.com";
const CORRECTED_EMAIL = "correct-user@example.com";
const OTHER_EMAIL = "other-user@example.com";
const TEST_PASSWORD = "valid-password-abc-123";
const TEST_NAME = "Typo User";

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

describe("Email verification (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let mailSend: ReturnType<typeof vi.fn>;
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
        send: mailSend,
        sendTest: vi.fn().mockResolvedValue(undefined),
      } satisfies MailService)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    accountsService = moduleRef.get(AccountsService);
    workspacesService = moduleRef.get(WorkspacesService);

    const account = await accountsService.registerAccount({
      email: TYPO_EMAIL,
      name: TEST_NAME,
      password: TEST_PASSWORD,
    });

    await workspacesService.createWorkspace(
      {
        name: `${TEST_NAME}'s workspace`,
        slug: "typo-user-ws",
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

  describe("POST /auth/correct-signup-email", () => {
    it("corrects the signup email, sends a new link, and verifies on the new address", async () => {
      mailSend.mockClear();

      const loginRes = await request(server())
        .post("/auth/login")
        .send({ email: TYPO_EMAIL, password: TEST_PASSWORD });

      expect(loginRes.status).toBe(200);
      const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

      const correctRes = await request(server())
        .post("/auth/correct-signup-email")
        .set("Cookie", sessionCookie)
        .send({ email: CORRECTED_EMAIL });

      expect(correctRes.status).toBe(200);
      expect(correctRes.body).toEqual({ maskedEmail: "c***@e***.com" });
      expect(mailSend).toHaveBeenCalledTimes(1);

      const mailPayload = mailSend.mock.calls[0]?.[0] as {
        to: string;
        text: string;
        type: string;
      };
      expect(mailPayload.to).toBe(CORRECTED_EMAIL);
      expect(mailPayload.type).toBe("signup_verification");

      const verifyToken = extractVerifyToken(mailPayload.text);
      expect(verifyToken).toBeDefined();

      const verifyRes = await request(server()).get(
        `/auth/verify-email?token=${verifyToken ?? ""}`,
      );
      expect(verifyRes.status).toBe(200);

      const meRes = await request(server())
        .get("/auth/me")
        .set("Cookie", sessionCookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body).toMatchObject({
        email: CORRECTED_EMAIL,
        emailVerified: true,
      });
    });

    it("returns 409 when the corrected email is already taken", async () => {
      await accountsService.registerAccount({
        email: OTHER_EMAIL,
        name: "Other User",
        password: TEST_PASSWORD,
      });

      const typoAccount = await accountsService.registerAccount({
        email: "another-typo@example.com",
        name: "Another Typo User",
        password: TEST_PASSWORD,
      });
      await workspacesService.createWorkspace(
        {
          name: "Another Typo Workspace",
          slug: "another-typo-ws",
          plan: "free",
        },
        typoAccount.id,
      );

      const loginRes = await request(server())
        .post("/auth/login")
        .send({ email: typoAccount.email, password: TEST_PASSWORD });

      const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

      const res = await request(server())
        .post("/auth/correct-signup-email")
        .set("Cookie", sessionCookie)
        .send({ email: OTHER_EMAIL });

      expect(res.status).toBe(409);
    });

    it("returns 403 for verified accounts", async () => {
      const verifiedAccount = await accountsService.registerAccount({
        email: "verified-user@example.com",
        name: "Verified User",
        password: TEST_PASSWORD,
      });
      await workspacesService.createWorkspace(
        {
          name: "Verified User Workspace",
          slug: "verified-user-ws",
          plan: "free",
        },
        verifiedAccount.id,
      );
      await accountsService.markEmailVerified(verifiedAccount.id);

      const loginRes = await request(server())
        .post("/auth/login")
        .send({ email: "verified-user@example.com", password: TEST_PASSWORD });

      const sessionCookie = extractSessionCookie(loginRes.headers["set-cookie"]);

      const res = await request(server())
        .post("/auth/correct-signup-email")
        .set("Cookie", sessionCookie)
        .send({ email: "new-verified@example.com" });

      expect(res.status).toBe(403);
    });
  });
});
