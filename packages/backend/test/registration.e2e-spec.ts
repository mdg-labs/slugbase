import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("Registration (integration) — PUBLIC_REGISTRATION=true", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  const REGISTER_EMAIL = "newuser@example.com";
  const REGISTER_PASSWORD = "myPassword123!";
  const REGISTER_NAME = "New User";

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      PUBLIC_REGISTRATION: "true",
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
    it("creates a new user and returns 201 with userId", async () => {
      const res = await request(server())
        .post("/auth/register")
        .send({
          email: REGISTER_EMAIL,
          password: REGISTER_PASSWORD,
          name: REGISTER_NAME,
        });

      expect(res.status).toBe(201);
      const body = res.body as { userId: string };
      expect(typeof body.userId).toBe("string");
      expect(body.userId.length).toBeGreaterThan(0);
    });

    it("sets a session cookie on successful registration", async () => {
      const res = await request(server())
        .post("/auth/register")
        .send({
          email: "another@example.com",
          password: REGISTER_PASSWORD,
          name: "Another User",
        });

      expect(res.status).toBe(201);
      const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    });

    it("returns 409 Conflict when email already exists", async () => {
      const res = await request(server())
        .post("/auth/register")
        .send({
          email: REGISTER_EMAIL,
          password: REGISTER_PASSWORD,
          name: REGISTER_NAME,
        });

      expect(res.status).toBe(409);
    });

    it("accepts custom workspaceName and workspaceSlug", async () => {
      const res = await request(server())
        .post("/auth/register")
        .send({
          email: "custom-ws@example.com",
          password: REGISTER_PASSWORD,
          name: "Custom WS User",
          workspaceName: "My Special Workspace",
          workspaceSlug: "my-special-workspace",
        });

      expect(res.status).toBe(201);
    });
  });
});
