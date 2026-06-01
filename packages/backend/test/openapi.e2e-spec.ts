import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import {
  applyTestEnv,
  clearTestEnv,
} from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

type OpenApiDocument = {
  openapi: string;
  info: { title: string };
  paths: Record<string, unknown>;
};

async function createApp(
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ app: INestApplication; cleanup: () => Promise<void> }> {
  const testDatabase = await createTestDatabase();
  applyTestEnv({ DATABASE_URL: testDatabase.databaseUrl, ...envOverrides });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    cleanup: async () => {
      await app.close();
      clearTestEnv();
      await testDatabase.cleanup();
    },
  };
}

describe("OpenAPI publish (integration)", () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const setup = await createApp({ OPENAPI_INTERACTIVE_DOCS: "true" });
    app = setup.app;
    cleanup = setup.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("GET /openapi.json returns the ts-rest generated OpenAPI document", async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/json/);

    const body = response.body as OpenApiDocument;
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("SlugBase API");
    expect(body.paths["/health"]).toBeDefined();
  });

  it("GET /docs returns interactive docs when OPENAPI_INTERACTIVE_DOCS is enabled", async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get("/docs");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/html/);
    expect(response.text).toContain("@scalar/api-reference");
    expect(response.text).toContain("/openapi.json");
  });
});

describe("OpenAPI interactive docs toggle (integration)", () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const setup = await createApp({ OPENAPI_INTERACTIVE_DOCS: "false" });
    app = setup.app;
    cleanup = setup.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("GET /docs returns 404 when OPENAPI_INTERACTIVE_DOCS is disabled", async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get("/docs");

    expect(response.status).toBe(404);
  });

  it("GET /openapi.json remains available when interactive docs are disabled", async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get("/openapi.json");

    expect(response.status).toBe(200);
    const body = response.body as OpenApiDocument;
    expect(body.openapi).toBe("3.1.0");
  });
});
