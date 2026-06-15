import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("Auth rate limiting (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    // Configure a very tight rate limit so tests complete quickly
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      RATE_LIMIT_LOGIN_MAX: "3",
      RATE_LIMIT_LOGIN_TTL_SECONDS: "60",
      RATE_LIMIT_TOKEN_CREATION_MAX: "3",
      RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS: "60",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
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

  describe("POST /auth/login - IP rate limit", () => {
    it("returns 429 with Retry-After header after exceeding the limit", async () => {
      const body = { email: "notexist@example.com", password: "doesnotmatter" };

      // Send up to the configured limit (3 in test env)
      await request(server()).post("/auth/login").send(body);
      await request(server()).post("/auth/login").send(body);
      await request(server()).post("/auth/login").send(body);

      // The next request should be throttled
      const res = await request(server()).post("/auth/login").send(body);

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      // Retry-After should be a positive number of seconds
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
    });
  });

  describe("POST /auth/forgot-password - IP rate limit", () => {
    it("returns 429 with Retry-After header after exceeding the limit", async () => {
      const body = { email: "notexist@example.com" };

      await request(server()).post("/auth/forgot-password").send(body);
      await request(server()).post("/auth/forgot-password").send(body);
      await request(server()).post("/auth/forgot-password").send(body);

      const res = await request(server()).post("/auth/forgot-password").send(body);

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("POST /setup/complete - IP rate limit", () => {
    it("returns 429 with Retry-After header after exceeding the limit", async () => {
      const body = {
        email: "admin@ratelimit.test",
        password: "adminPassword123!",
        name: "Admin User",
        workspaceName: "Admin Workspace",
        workspaceSlug: "admin-ratelimit",
      };

      await request(server()).post("/setup/complete").send(body);
      await request(server()).post("/setup/complete").send(body);
      await request(server()).post("/setup/complete").send(body);

      const res = await request(server()).post("/setup/complete").send(body);

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("POST /invitations/:token/accept - IP rate limit", () => {
    it("returns 429 with Retry-After header after exceeding the limit", async () => {
      const body = { name: "Rate Limit User", password: "securepassword123!" };

      await request(server()).post("/invitations/invalid-token/accept").send(body);
      await request(server()).post("/invitations/invalid-token/accept").send(body);
      await request(server()).post("/invitations/invalid-token/accept").send(body);

      const res = await request(server())
        .post("/invitations/invalid-token/accept")
        .send(body);

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });
});
