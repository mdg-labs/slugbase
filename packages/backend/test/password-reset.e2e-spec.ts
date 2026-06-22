import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MailService } from "@slugbase/shared-types";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { MAIL } from "../src/mail/mail.tokens.js";
import { applyTestEnv, clearTestEnv, validTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

const HOSTED_TEST_EMAIL = "reset-link-hosted@example.com";
const SELFHOST_TEST_EMAIL = "reset-link-selfhost@example.com";
const TEST_PASSWORD = "valid-password-abc-123";
const TEST_NAME = "Reset Link User";

async function createPasswordResetApp(params: {
  envOverrides: NodeJS.ProcessEnv;
  mailSend: ReturnType<typeof vi.fn>;
  accountEmail: string;
}): Promise<{ app: INestApplication; cleanup: () => Promise<void> }> {
  const testDatabase = await createTestDatabase();
  applyTestEnv({
    DATABASE_URL: testDatabase.databaseUrl,
    ...params.envOverrides,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAIL)
    .useValue({
      isAvailable: () => true,
      ensureAvailable: () => Promise.resolve(true),
      send: params.mailSend,
      sendTest: vi.fn().mockResolvedValue(undefined),
    } satisfies MailService)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const accountsService = moduleRef.get(AccountsService);
  await accountsService.registerAccount({
    email: params.accountEmail,
    name: TEST_NAME,
    password: TEST_PASSWORD,
  });

  return {
    app,
    cleanup: async () => {
      await app.close();
      clearTestEnv();
      await testDatabase.cleanup();
    },
  };
}

function extractResetUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match?.[0];
}

describe("Password reset email link (integration)", () => {
  describe("hosted topology (SERVE_WEB_CLIENT=false)", () => {
    let app: INestApplication | undefined;
    let cleanup: () => Promise<void> = async () => {};
    let mailSend: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      mailSend = vi.fn().mockResolvedValue(undefined);
      const setup = await createPasswordResetApp({
        envOverrides: {
          APP_BASE_URL: "https://api.slugbase.test",
          FRONTEND_ORIGIN: "https://app.slugbase.test",
          SERVE_WEB_CLIENT: "false",
        },
        mailSend,
        accountEmail: HOSTED_TEST_EMAIL,
      });
      app = setup.app;
      cleanup = setup.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    function server(): Server {
      if (!app) throw new Error("app not initialized");
      return app.getHttpServer() as Server;
    }

    it("returns 200 for unknown emails without sending mail", async () => {
      mailSend.mockClear();

      const res = await request(server())
        .post("/auth/forgot-password")
        .send({ email: "unknown@example.com" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mailSend).not.toHaveBeenCalled();
    });

    it("emails a FRONTEND_ORIGIN /reset-password link", async () => {
      mailSend.mockClear();

      const res = await request(server())
        .post("/auth/forgot-password")
        .send({ email: HOSTED_TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(mailSend).toHaveBeenCalledTimes(1);

      const payload = mailSend.mock.calls[0]?.[0] as { text: string; type: string };
      expect(payload.type).toBe("password_reset");

      const resetUrl = extractResetUrl(payload.text);
      expect(resetUrl).toBeDefined();
      expect(resetUrl).toMatch(/^https:\/\/app\.slugbase\.test\/reset-password\?token=[0-9a-f]{64}$/);
      expect(resetUrl).not.toContain(validTestEnv.APP_BASE_URL ?? "");
    });
  });

  describe("self-hosted combined topology (SERVE_WEB_CLIENT=true)", () => {
    let app: INestApplication | undefined;
    let cleanup: () => Promise<void> = async () => {};
    let mailSend: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      mailSend = vi.fn().mockResolvedValue(undefined);
      const setup = await createPasswordResetApp({
        envOverrides: {
          APP_BASE_URL: "https://slugbase.example.com",
          FRONTEND_ORIGIN: "https://app.slugbase.test",
          SERVE_WEB_CLIENT: "true",
          WEB_CLIENT_SERVER_BUILD: "/tmp/web-build",
        },
        mailSend,
        accountEmail: SELFHOST_TEST_EMAIL,
      });
      app = setup.app;
      cleanup = setup.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    function server(): Server {
      if (!app) throw new Error("app not initialized");
      return app.getHttpServer() as Server;
    }

    it("emails an APP_BASE_URL /reset-password link", async () => {
      mailSend.mockClear();

      const res = await request(server())
        .post("/auth/forgot-password")
        .send({ email: SELFHOST_TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(mailSend).toHaveBeenCalledTimes(1);

      const payload = mailSend.mock.calls[0]?.[0] as { text: string; type: string };
      expect(payload.type).toBe("password_reset");

      const resetUrl = extractResetUrl(payload.text);
      expect(resetUrl).toBeDefined();
      expect(resetUrl).toMatch(
        /^https:\/\/slugbase\.example\.com\/reset-password\?token=[0-9a-f]{64}$/,
      );
      expect(resetUrl).not.toContain("app.slugbase.test");
    });
  });
});
