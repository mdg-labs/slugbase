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
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("API Tokens (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  const TEST_EMAIL = "apitoken@example.com";
  const TEST_PASSWORD = "api-token-password-123";
  const TEST_NAME = "API Token Test User";

  let sessionCookie = "";
  let csrfToken = "";
  let csrfCookie = "";
  let createdTokenId = "";
  let createdTokenPlaintext = "";

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

  async function login(): Promise<string> {
    const res = await request(server())
      .post("/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);

    const setCookieHeader = res.headers["set-cookie"] as string[] | string | undefined;
    const cookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    const cookieStr =
      cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0] ?? "";
    expect(cookieStr).toBeTruthy();
    return cookieStr;
  }

  async function fetchCsrfToken(cookie: string): Promise<{ token: string; cookie: string }> {
    const res = await request(server())
      .get("/auth/csrf-token")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    const body = res.body as { csrfToken: string };
    expect(typeof body.csrfToken).toBe("string");

    const setCookieHeader = res.headers["set-cookie"] as string[] | string | undefined;
    const cookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    const csrfCookieStr = cookies.find((c) => c.startsWith("csrf_token="))?.split(";")[0] ?? "";
    return { token: body.csrfToken, cookie: csrfCookieStr };
  }

  it("logs in and obtains a session cookie + CSRF token", async () => {
    sessionCookie = await login();
    expect(sessionCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));

    const csrf = await fetchCsrfToken(sessionCookie);
    csrfToken = csrf.token;
    csrfCookie = csrf.cookie;
    expect(csrfToken.length).toBeGreaterThan(0);
  });

  describe("POST /auth/api-tokens", () => {
    it("creates a token and returns the plaintext exactly once", async () => {
      const res = await request(server())
        .post("/auth/api-tokens")
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send({ name: "my-test-token" });

      expect(res.status).toBe(201);
      const body = res.body as { token: { id: string; name: string }; plaintext: string };
      expect(body.token.name).toBe("my-test-token");
      expect(body.plaintext).toMatch(/^slb_[0-9a-f]{64}$/);

      createdTokenId = body.token.id;
      createdTokenPlaintext = body.plaintext;
    });

    it("returns 403 (CSRF failure) without a CSRF token", async () => {
      const res = await request(server())
        .post("/auth/api-tokens")
        .set("Cookie", sessionCookie)
        .send({ name: "will-fail" });
      expect(res.status).toBe(403);
    });

    it("returns 401 without any auth", async () => {
      const res = await request(server())
        .post("/auth/api-tokens")
        .set("Authorization", "Bearer slb_" + "0".repeat(64))
        .send({ name: "will-fail" });
      expect(res.status).toBe(401);
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(server())
        .post("/auth/api-tokens")
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 409 when a token with the same name already exists", async () => {
      const res = await request(server())
        .post("/auth/api-tokens")
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken)
        .send({ name: "my-test-token" });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /auth/api-tokens (session auth)", () => {
    it("lists the created token without exposing the hash", async () => {
      const res = await request(server())
        .get("/auth/api-tokens")
        .set("Cookie", sessionCookie);

      expect(res.status).toBe(200);
      const body = res.body as { tokens: Array<{ id: string; name: string }> };
      expect(Array.isArray(body.tokens)).toBe(true);
      const token = body.tokens.find((t) => t.id === createdTokenId);
      expect(token).toBeDefined();
      expect(token?.name).toBe("my-test-token");
      expect(token).not.toHaveProperty("tokenHash");
      expect(token).not.toHaveProperty("token_hash");
    });
  });

  describe("GET /auth/api-tokens (Bearer auth)", () => {
    it("accepts a valid bearer token and returns the token list", async () => {
      expect(createdTokenPlaintext).toMatch(/^slb_[0-9a-f]{64}$/);

      const res = await request(server())
        .get("/auth/api-tokens")
        .set("Authorization", `Bearer ${createdTokenPlaintext}`);

      expect(res.status).toBe(200);
      const body = res.body as { tokens: Array<{ id: string }> };
      expect(Array.isArray(body.tokens)).toBe(true);
      expect(body.tokens.some((t) => t.id === createdTokenId)).toBe(true);
    });

    it("returns 401 for an invalid bearer token", async () => {
      const res = await request(server())
        .get("/auth/api-tokens")
        .set("Authorization", "Bearer slb_" + "0".repeat(64));

      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /auth/api-tokens/:id", () => {
    it("deletes the token by ID using session auth", async () => {
      const res = await request(server())
        .delete(`/auth/api-tokens/${createdTokenId}`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken);

      expect(res.status).toBe(200);
      const body = res.body as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("returns 404 when deleting an already-deleted token", async () => {
      const res = await request(server())
        .delete(`/auth/api-tokens/${createdTokenId}`)
        .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
        .set("x-csrf-token", csrfToken);

      expect(res.status).toBe(404);
    });
  });

  describe("Bearer auth rejected after token deletion", () => {
    it("returns 401 when using the deleted token", async () => {
      const res = await request(server())
        .get("/auth/api-tokens")
        .set("Authorization", `Bearer ${createdTokenPlaintext}`);

      expect(res.status).toBe(401);
    });
  });
});
