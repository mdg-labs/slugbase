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

describe("Setup (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

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

  describe("GET /setup/status", () => {
    it("returns needsSetup: true on a fresh DB with no users", async () => {
      const res = await request(server()).get("/setup/status");
      expect(res.status).toBe(200);
      const body = res.body as { needsSetup: boolean };
      expect(body.needsSetup).toBe(true);
    });
  });

  describe("POST /setup/complete", () => {
    const completeBody = {
      email: "admin@setup.test",
      password: "adminPassword123!",
      name: "Admin User",
      workspaceName: "Admin Workspace",
      workspaceSlug: "admin-workspace",
    };

    it("creates the first admin user, returns 201 with userId, and sets a session cookie", async () => {
      const res = await request(server())
        .post("/setup/complete")
        .send(completeBody);

      expect(res.status).toBe(201);
      const body = res.body as { userId: string };
      expect(typeof body.userId).toBe("string");
      expect(body.userId.length).toBeGreaterThan(0);

      const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    });

    it("returns 409 Conflict on a second call (idempotency)", async () => {
      const res = await request(server())
        .post("/setup/complete")
        .send(completeBody);

      expect(res.status).toBe(409);
    });

    it("returns 409 even with different credentials on repeat call", async () => {
      const res = await request(server())
        .post("/setup/complete")
        .send({
          ...completeBody,
          email: "admin2@setup.test",
          workspaceSlug: "admin-workspace-2",
        });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /setup/status after setup", () => {
    it("returns needsSetup: false after setup is complete", async () => {
      const res = await request(server()).get("/setup/status");
      expect(res.status).toBe(200);
      const body = res.body as { needsSetup: boolean };
      expect(body.needsSetup).toBe(false);
    });
  });
});

describe("Setup status with public registration (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
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

  it("returns needsSetup: false when public registration is enabled", async () => {
    const res = await request(server()).get("/setup/status");
    expect(res.status).toBe(200);
    const body = res.body as { needsSetup: boolean };
    expect(body.needsSetup).toBe(false);
  });
});
