import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("Registration (integration) - PUBLIC_REGISTRATION=false", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      PUBLIC_REGISTRATION: "false",
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

  describe("POST /auth/register", () => {
    it("returns 403 Forbidden when PUBLIC_REGISTRATION is false", async () => {
      const res = await request(server())
        .post("/auth/register")
        .send({
          email: "blocked@example.com",
          password: "blockedPass123!",
          name: "Blocked User",
        });

      expect(res.status).toBe(403);
    });

    it("does not set a session cookie on 403", async () => {
      const res = await request(server())
        .post("/auth/register")
        .send({
          email: "blocked2@example.com",
          password: "blockedPass123!",
          name: "Blocked User 2",
        });

      expect(res.status).toBe(403);
      const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    });
  });
});
