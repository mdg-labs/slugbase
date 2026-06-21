import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { validateEnvConfig } from "../src/config/env.schema.js";
import { applySecurityHeaders } from "../src/security/apply-security-headers.js";
import {
  applyTestEnv,
  clearTestEnv,
  productionEnvWithoutSessionSecret,
  validTestEnv,
} from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

const EXPECTED_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
} as const;

function expectSecurityHeaders(
  headers: request.Response["headers"],
): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(headers[name]).toBe(value);
  }
  expect(headers["content-security-policy"]).toBeUndefined();
}

function getServer(app: INestApplication | undefined): Server {
  if (!app) {
    throw new Error("app not initialized");
  }
  return app.getHttpServer() as Server;
}

describe("health and version (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applySecurityHeaders(app, { enableHsts: false });
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    clearTestEnv();
    await cleanup();
  });

  it("GET /health returns 200 with ok status", async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("GET /health includes Helmet security headers", async () => {
    const response = await request(getServer(app)).get("/health");

    expectSecurityHeaders(response.headers);
  });

  it("GET /version returns 200 with package version", async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get("/version");

    expect(response.status).toBe(200);
    const body = response.body as { version: string };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("production startup validation (integration)", () => {
  it("throws when a required secret is missing in production mode", () => {
    expect(() =>
      validateEnvConfig(productionEnvWithoutSessionSecret()),
    ).toThrow(/Production startup refused/);
  });

  it("throws when edition preset conflicts in production mode", () => {
    expect(() =>
      validateEnvConfig({
        ...validTestEnv,
        NODE_ENV: "production",
        SLUGBASE_EDITION: "ce",
        VITE_BILLING_ENABLED: "true",
      }),
    ).toThrow(/Production startup refused/);
  });
});

describe("security headers with interactive docs (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      OPENAPI_INTERACTIVE_DOCS: "true",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applySecurityHeaders(app, { enableHsts: false });
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    clearTestEnv();
    await cleanup();
  });

  it("GET /docs returns Scalar HTML without a restrictive CSP header", async () => {
    const response = await request(getServer(app)).get("/docs");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/html/);
    expect(response.text).toContain("@scalar/api-reference");
    expectSecurityHeaders(response.headers);
  });
});

describe("security headers on /go responses (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applySecurityHeaders(app, { enableHsts: false });
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    clearTestEnv();
    await cleanup();
  });

  it("GET /go/:slug includes security headers on unauthenticated responses", async () => {
    const response = await request(getServer(app)).get("/go/example");

    expect(response.status).toBe(401);
    expectSecurityHeaders(response.headers);
  });
});

describe("production HSTS (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applySecurityHeaders(app, { enableHsts: true });
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    clearTestEnv();
    await cleanup();
  });

  it("GET /health emits Strict-Transport-Security when HSTS is enabled", async () => {
    const response = await request(getServer(app)).get("/health");

    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});
