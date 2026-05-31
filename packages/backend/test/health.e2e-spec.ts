import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { validateEnvConfig } from "../src/config/env.schema.js";
import { runMigrations } from "../src/db/migrate/run-migrations.js";
import {
  applyTestEnv,
  clearTestEnv,
  productionEnvWithoutSessionSecret,
} from "../src/test-utils/test-env.js";

let tempDir: string;
let databaseUrl: string;

async function initTestDatabase(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), "slugbase-health-"));
  const dbPath = join(tempDir, "health.sqlite");
  databaseUrl = `sqlite://${dbPath}`;
  runMigrations(databaseUrl);
}

describe("health and version (integration)", () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    await initTestDatabase();
    applyTestEnv({ DATABASE_URL: databaseUrl });

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
    await rm(tempDir, { recursive: true, force: true });
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
