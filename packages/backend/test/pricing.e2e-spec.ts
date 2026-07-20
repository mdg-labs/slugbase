import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { loadAppConfig } from "../src/config/load-config.js";
import { resolveCorsOrigins } from "../src/config/resolve-cors-origins.js";
import type { PricingResponse } from "../src/billing/pricing.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("GET /pricing/public (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      MARKETING_ORIGIN: "https://www.slugbase.test",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    const config = loadAppConfig(process.env);
    app.enableCors({
      origin: resolveCorsOrigins(config),
      credentials: true,
    });
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  it("returns 200 with CE pricing metadata", async () => {
    const server = (app as INestApplication).getHttpServer() as Server;
    const response = await request(server).get("/pricing/public");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");

    const body = response.body as PricingResponse;
    expect(body.freeBookmarkCap).toBe(50);
    expect(body.teamBaseSeats).toBe(5);
    expect(body.plans.personal).toEqual({});
    expect(body.plans.team).toEqual({});
    expect(body.plans.supporter).toBeUndefined();
  });

  it("does not require authentication", async () => {
    const server = (app as INestApplication).getHttpServer() as Server;
    const response = await request(server).get("/pricing/public");

    expect(response.status).toBe(200);
  });

  it("returns Access-Control-Allow-Origin for marketing origin", async () => {
    const marketingOrigin = "https://www.slugbase.test";
    const server = (app as INestApplication).getHttpServer() as Server;
    const response = await request(server)
      .get("/pricing/public")
      .set("Origin", marketingOrigin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      marketingOrigin,
    );
  });
});
