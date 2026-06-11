import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SESSION_COOKIE } from "../src/auth/login-logout.controller.js";
import { OidcRepository } from "../src/auth/oidc/oidc.repository.js";
import { AesGcmCryptoService } from "../src/crypto/aes-gcm-crypto.service.js";
import { DbService } from "../src/db/db.service.js";
import { applyTestEnv, clearTestEnv, validTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

/**
 * Mock openid-client so we never hit a real IdP in integration tests.
 */
vi.mock("openid-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("openid-client")>();
  return {
    ...original,
    discovery: vi.fn(),
    authorizationCodeGrant: vi.fn(),
    buildAuthorizationUrl: vi.fn(),
  };
});

const MOCK_SUBJECT = "oidc-user-sub-001";
const MOCK_EMAIL = "oidcuser@example.com";
const MOCK_NAME = "OIDC Test User";
const MOCK_ISSUER = "https://idp.example.com";
const MOCK_CLIENT_ID = "test-client-id";
const MOCK_CLIENT_SECRET = "test-client-secret-value";
const MOCK_AUTH_URL = "https://idp.example.com/authorize?response_type=code";

describe("OIDC (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let testProviderId: string;

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

    const secretEncrypted = cryptoService.encrypt(MOCK_CLIENT_SECRET);
    const provider = await oidcRepo.createProvider({
      name: "Test IdP",
      issuerUrl: MOCK_ISSUER,
      clientId: MOCK_CLIENT_ID,
      clientSecretEncrypted: secretEncrypted,
      scopes: "openid email profile",
      enabled: true,
    });
    testProviderId = provider.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
    vi.restoreAllMocks();
  });

  function server(): Server {
    if (!app) throw new Error("app not initialized");
    return app.getHttpServer() as Server;
  }

  describe("GET /auth/oidc/:providerId/authorize", () => {
    it("redirects (302) to IdP authorization URL and sets OIDC state cookie", async () => {
      const { buildAuthorizationUrl, discovery } = await import("openid-client");
      vi.mocked(discovery).mockResolvedValue({} as never);
      vi.mocked(buildAuthorizationUrl).mockReturnValue(new URL(MOCK_AUTH_URL));

      const res = await request(server()).get(
        `/auth/oidc/${testProviderId}/authorize`,
      );

      expect(res.status).toBe(302);
      expect(res.headers["location"]).toContain("idp.example.com");

      const setCookieHeader = res.headers["set-cookie"] as
        | string[]
        | string
        | undefined;
      const cookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader
          ? [setCookieHeader]
          : [];
      expect(cookies.some((c) => c.includes("slb_oidc_state="))).toBe(true);
    });

    it("returns 404 for an unknown or disabled provider", async () => {
      const res = await request(server()).get(
        "/auth/oidc/00000000-0000-0000-0000-000000000000/authorize",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /auth/oidc/:providerId/callback", () => {
    it("creates user_account + oidc_account and issues session cookie on first federated login", async () => {
      const { buildAuthorizationUrl, discovery, authorizationCodeGrant } =
        await import("openid-client");

      vi.mocked(discovery).mockResolvedValue({} as never);
      vi.mocked(buildAuthorizationUrl).mockReturnValue(new URL(MOCK_AUTH_URL));
      vi.mocked(authorizationCodeGrant).mockResolvedValue({
        claims: () => ({
          sub: MOCK_SUBJECT,
          email: MOCK_EMAIL,
          email_verified: true,
          name: MOCK_NAME,
          iss: MOCK_ISSUER,
          aud: MOCK_CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      } as never);

      // Step 1 - initiate flow to get encrypted OIDC state cookie
      const authorizeRes = await request(server()).get(
        `/auth/oidc/${testProviderId}/authorize`,
      );
      expect(authorizeRes.status).toBe(302);

      const authCookies = (
        Array.isArray(authorizeRes.headers["set-cookie"])
          ? authorizeRes.headers["set-cookie"]
          : [authorizeRes.headers["set-cookie"] ?? ""]
      ) as string[];
      const oidcStateCookie = authCookies
        .find((c) => c.includes("slb_oidc_state="))
        ?.split(";")[0];
      expect(oidcStateCookie).toBeDefined();

      // Step 2 - simulate IdP redirect back with state cookie present
      const callbackRes = await request(server())
        .get(
          `/auth/oidc/${testProviderId}/callback?code=mock_code&state=mock_state`,
        )
        .set("Cookie", oidcStateCookie ?? "");

      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers["location"]).toBe(validTestEnv.FRONTEND_ORIGIN);

      const callbackCookies = (
        Array.isArray(callbackRes.headers["set-cookie"])
          ? callbackRes.headers["set-cookie"]
          : [callbackRes.headers["set-cookie"] ?? ""]
      ) as string[];
      expect(
        callbackCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`)),
      ).toBe(true);
    });

    it("returns 401 when OIDC state cookie is absent", async () => {
      const res = await request(server()).get(
        `/auth/oidc/${testProviderId}/callback?code=x&state=y`,
      );
      expect(res.status).toBe(401);
    });
  });
});
