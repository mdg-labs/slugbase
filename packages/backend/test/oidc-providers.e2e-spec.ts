import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ListPublicOidcProvidersResponse } from "@slugbase/shared-types";

import { AppModule } from "../src/app.module.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("GET /auth/oidc/providers (integration)", () => {
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

  it("returns an empty list when no OIDC env providers are configured", async () => {
    const res = await request(server()).get("/auth/oidc/providers").expect(200);
    const body = res.body as ListPublicOidcProvidersResponse;

    expect(body).toEqual({ providers: [] });
  });
});

describe("GET /auth/oidc/providers env-configured source (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      OIDC_google_CLIENT_ID: "google-client",
      OIDC_google_CLIENT_SECRET: "google-secret",
      OIDC_google_ISSUER_URL: "https://accounts.google.com",
      OIDC_google_NAME: "Google",
      OIDC_disabled_idp_CLIENT_ID: "disabled-client",
      OIDC_disabled_idp_CLIENT_SECRET: "disabled-secret",
      OIDC_disabled_idp_ISSUER_URL: "https://disabled.example.com",
      OIDC_disabled_idp_NAME: "Disabled IdP",
      OIDC_disabled_idp_ENABLED: "false",
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

  it("returns enabled env-configured providers with safe metadata only", async () => {
    const res = await request(server()).get("/auth/oidc/providers").expect(200);
    const body = res.body as ListPublicOidcProvidersResponse;

    expect(body.providers).toEqual([{ id: "google", name: "Google" }]);
    expect(body.providers[0]).not.toHaveProperty("issuerUrl");
    expect(body.providers[0]).not.toHaveProperty("clientId");
    expect(body.providers[0]).not.toHaveProperty("clientSecret");
  });

  it("omits disabled env-configured providers from the public list", async () => {
    const res = await request(server()).get("/auth/oidc/providers").expect(200);
    const body = res.body as ListPublicOidcProvidersResponse;

    const names = body.providers.map((provider) => provider.name);
    expect(names).not.toContain("Disabled IdP");
  });
});
