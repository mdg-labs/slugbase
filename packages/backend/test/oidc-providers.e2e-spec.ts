import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ListPublicOidcProvidersResponse } from "@slugbase/shared-types";

import { AppModule } from "../src/app.module.js";
import { OidcRepository } from "../src/auth/oidc/oidc.repository.js";
import { AesGcmCryptoService } from "../src/crypto/aes-gcm-crypto.service.js";
import { DbService } from "../src/db/db.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("GET /auth/oidc/providers (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let enabledProviderId: string;

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

    const db = moduleRef.get(DbService);
    const cryptoService = moduleRef.get(AesGcmCryptoService);
    const oidcRepo = new OidcRepository(db.getOrm());
    const secretEncrypted = cryptoService.encrypt("test-client-secret");

    const enabled = await oidcRepo.createProvider({
      name: "Enabled IdP",
      issuerUrl: "https://enabled.example.com",
      clientId: "enabled-client",
      clientSecretEncrypted: secretEncrypted,
      scopes: "openid email profile",
      enabled: true,
    });
    enabledProviderId = enabled.id;

    await oidcRepo.createProvider({
      name: "Disabled IdP",
      issuerUrl: "https://disabled.example.com",
      clientId: "disabled-client",
      clientSecretEncrypted: secretEncrypted,
      scopes: "openid email profile",
      enabled: false,
    });
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

  it("returns enabled providers with safe metadata only (no auth required)", async () => {
    const res = await request(server()).get("/auth/oidc/providers").expect(200);
    const body = res.body as ListPublicOidcProvidersResponse;

    const enabled = body.providers.find((p) => p.id === enabledProviderId);
    expect(enabled).toEqual({ id: enabledProviderId, name: "Enabled IdP" });
    expect(enabled).not.toHaveProperty("issuerUrl");
    expect(enabled).not.toHaveProperty("clientId");
    expect(enabled).not.toHaveProperty("clientSecret");
    expect(enabled).not.toHaveProperty("hasClientSecret");
  });

  it("omits disabled providers from the public list", async () => {
    const res = await request(server()).get("/auth/oidc/providers").expect(200);
    const body = res.body as ListPublicOidcProvidersResponse;

    const names = body.providers.map((p) => p.name);
    expect(names).toContain("Enabled IdP");
    expect(names).not.toContain("Disabled IdP");
  });
});

describe("GET /auth/oidc/providers hosted interim (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_hosted_mode",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const db = moduleRef.get(DbService);
    const cryptoService = moduleRef.get(AesGcmCryptoService);
    const oidcRepo = new OidcRepository(db.getOrm());
    const secretEncrypted = cryptoService.encrypt("test-client-secret");

    await oidcRepo.createProvider({
      name: "DB Provider",
      issuerUrl: "https://db.example.com",
      clientId: "db-client",
      clientSecretEncrypted: secretEncrypted,
      enabled: true,
    });
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

  it("returns an empty list on hosted deployments until deployment-config source lands", async () => {
    const res = await request(server()).get("/auth/oidc/providers").expect(200);
    const body = res.body as ListPublicOidcProvidersResponse;

    expect(body).toEqual({ providers: [] });
  });
});
