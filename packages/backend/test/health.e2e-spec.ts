import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { validateEnvConfig } from "../src/config/env.schema.js";
import {
  applyTestEnv,
  clearTestEnv,
  productionEnvWithoutSessionSecret,
} from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

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
});
