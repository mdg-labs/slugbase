import "reflect-metadata";

import { Controller, type INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SkipCsrf } from "../src/auth/csrf/skip-csrf.decorator.js";
import { SessionService } from "../src/sessions/session.service.js";
import type { SessionRecord } from "../src/sessions/session.types.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

/** Minimal controller used only inside this test module. */
@Controller("test")
class TestMutationController {
  @Post("mutate")
  mutate(): { ok: boolean } {
    return { ok: true };
  }

  @Post("exempt")
  @SkipCsrf()
  exempt(): { ok: boolean } {
    return { ok: true };
  }
}

describe("SessionService (integration)", () => {
  let sessionService: SessionService | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    sessionService = moduleRef.get(SessionService);
  });

  afterAll(async () => {
    clearTestEnv();
    await cleanup();
  });

  it("creates a session and returns a signed cookie value", async () => {
    const svc = sessionService;
    expect(svc).toBeDefined();
    if (!svc) return;

    const { sessionId, cookieValue } = await svc.createSession({
      userId: "user-1",
    });

    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(cookieValue).toContain(".");

    const verified = svc.verifySessionCookie(cookieValue);
    expect(verified).toBe(sessionId);
  });

  it("finds a created session", async () => {
    const svc = sessionService;
    expect(svc).toBeDefined();
    if (!svc) return;

    const { sessionId } = await svc.createSession({
      userId: "user-2",
      data: { workspace: "ws-abc" },
    });

    const record: SessionRecord | null = await svc.findSession(sessionId);
    expect(record).not.toBeNull();
    if (!record) return;

    expect(record.userId).toBe("user-2");
    expect(record.data).toEqual({ workspace: "ws-abc" });
    expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("revokes a session individually", async () => {
    const svc = sessionService;
    expect(svc).toBeDefined();
    if (!svc) return;

    const { sessionId } = await svc.createSession({ userId: "user-3" });
    await svc.revokeSession(sessionId);
    const record = await svc.findSession(sessionId);
    expect(record).toBeNull();
  });

  it("revokes all sessions for a user (log-out-everywhere)", async () => {
    const svc = sessionService;
    expect(svc).toBeDefined();
    if (!svc) return;

    const { sessionId: s1 } = await svc.createSession({ userId: "user-4" });
    const { sessionId: s2 } = await svc.createSession({ userId: "user-4" });

    await svc.revokeAllSessions("user-4");

    expect(await svc.findSession(s1)).toBeNull();
    expect(await svc.findSession(s2)).toBeNull();
  });

  it("verifySessionCookie rejects a tampered value", () => {
    const svc = sessionService;
    expect(svc).toBeDefined();
    if (!svc) return;

    expect(svc.verifySessionCookie("fake.bad-mac")).toBeNull();
  });
});

describe("CSRF guard (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await runMigrations(testDatabase.databaseUrl);
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestMutationController],
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

  it("GET /auth/csrf-token returns a token and sets csrf_token cookie", async () => {
    const res = await request(server()).get("/auth/csrf-token");

    expect(res.status).toBe(200);
    const body = res.body as { csrfToken: string };
    expect(typeof body.csrfToken).toBe("string");
    expect(body.csrfToken.length).toBeGreaterThan(0);

    const setCookie = res.headers["set-cookie"] as string[] | string;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.some((c) => c.startsWith("csrf_token="))).toBe(true);
  });

  it("POST to a mutating endpoint without CSRF token returns 403", async () => {
    const res = await request(server()).post("/test/mutate");
    expect(res.status).toBe(403);
  });

  it("POST with valid CSRF token (header + cookie) succeeds", async () => {
    const tokenRes = await request(server()).get("/auth/csrf-token");
    const body = tokenRes.body as { csrfToken: string };
    const csrfToken = body.csrfToken;

    const setCookieHeader = tokenRes.headers["set-cookie"] as string[];
    const csrfCookie = setCookieHeader[0] ?? "";

    const mutRes = await request(server())
      .post("/test/mutate")
      .set("Cookie", csrfCookie)
      .set("X-CSRF-Token", csrfToken);

    expect(mutRes.status).toBe(201);
  });

  it("POST with mismatched header and cookie returns 403", async () => {
    const tokenRes = await request(server()).get("/auth/csrf-token");
    const setCookieHeader = tokenRes.headers["set-cookie"] as string[];
    const csrfCookie = setCookieHeader[0] ?? "";

    const mutRes = await request(server())
      .post("/test/mutate")
      .set("Cookie", csrfCookie)
      .set("X-CSRF-Token", "wrong-token");

    expect(mutRes.status).toBe(403);
  });

  it("POST to @SkipCsrf() endpoint succeeds without a token", async () => {
    const res = await request(server()).post("/test/exempt");
    expect(res.status).toBe(201);
  });

  it("GET /health is always exempt (safe method)", async () => {
    const res = await request(server()).get("/health");
    expect(res.status).toBe(200);
  });
});
