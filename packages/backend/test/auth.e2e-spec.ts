import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { SessionService } from "../src/sessions/session.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Auth (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  const TEST_EMAIL = "authtest@example.com";
  const TEST_PASSWORD = "valid-password-abc-123";
  const TEST_NAME = "Auth Test User";

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
    await accountsService.registerAccount({
      email: TEST_EMAIL,
      name: TEST_NAME,
      password: TEST_PASSWORD,
    });
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

  describe("POST /auth/login", () => {
    it("returns 200 and sets session cookie on valid credentials", async () => {
      const res = await request(server())
        .post("/auth/login")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      const body = res.body as { userId: string };
      expect(typeof body.userId).toBe("string");
      expect(body.userId.length).toBeGreaterThan(0);

      const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
      const cookies = Array.isArray(setCookie)
        ? setCookie
        : setCookie
          ? [setCookie]
          : [];
      expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    });

    it("returns 401 for wrong password", async () => {
      const res = await request(server())
        .post("/auth/login")
        .send({ email: TEST_EMAIL, password: "wrong-password-xyz" });

      expect(res.status).toBe(401);
    });

    it("returns 401 for unknown email", async () => {
      const res = await request(server())
        .post("/auth/login")
        .send({ email: "nobody@example.com", password: TEST_PASSWORD });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/logout", () => {
    it("revokes the session and clears the cookie", async () => {
      const loginRes = await request(server())
        .post("/auth/login")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      expect(loginRes.status).toBe(200);

      const setCookieHeader = loginRes.headers["set-cookie"] as string[] | string;
      const cookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : [setCookieHeader];
      const sessionCookieHeader = cookies.find((c) =>
        c.startsWith(`${SESSION_COOKIE}=`),
      );
      expect(sessionCookieHeader).toBeDefined();

      const sessionCookieValue = sessionCookieHeader?.split(";")[0] ?? "";

      const logoutRes = await request(server())
        .post("/auth/logout")
        .set("Cookie", sessionCookieValue);

      expect(logoutRes.status).toBe(200);
      const body = logoutRes.body as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("verifies session is revoked after logout", async () => {
      const moduleRef = (app as INestApplication & { get: (t: unknown) => unknown });
      const sessionService = (moduleRef as unknown as { get: (t: unknown) => SessionService }).get(SessionService);

      const loginRes = await request(server())
        .post("/auth/login")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

      const setCookieHeader = loginRes.headers["set-cookie"] as string[] | string;
      const cookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : [setCookieHeader];
      const sessionCookieHeader = cookies.find((c) =>
        c.startsWith(`${SESSION_COOKIE}=`),
      );
      const sessionCookieValue = sessionCookieHeader?.split(";")[0] ?? "";
      const cookieValue = sessionCookieValue.split("=").slice(1).join("=");

      await request(server())
        .post("/auth/logout")
        .set("Cookie", sessionCookieValue);

      const sessionId = sessionService.verifySessionCookie(cookieValue);
      expect(sessionId).not.toBeNull();
      if (sessionId) {
        const record = await sessionService.findSession(sessionId);
        expect(record).toBeNull();
      }
    });

    it("succeeds even without a session cookie (idempotent)", async () => {
      const res = await request(server()).post("/auth/logout");
      expect(res.status).toBe(200);
    });
  });
});
