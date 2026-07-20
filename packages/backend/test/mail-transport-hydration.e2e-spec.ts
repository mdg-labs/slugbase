import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { SmtpMailService } from "../src/mail/smtp-mail.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("SMTP env-only transport (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let smtpMail: SmtpMailService;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
    });
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    smtpMail = moduleRef.get(SmtpMailService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    clearTestEnv();
    await cleanup();
  });

  it("is unavailable when SMTP_HOST env is absent", () => {
    expect(smtpMail.isAvailable()).toBe(false);
  });

  it("ensureAvailable stays false without env SMTP configuration", async () => {
    await expect(smtpMail.ensureAvailable()).resolves.toBe(false);
  });

  it("stays unavailable after app restart without env SMTP configuration", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required");
    }

    const freshModuleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const freshApp = freshModuleRef.createNestApplication();
    await freshApp.init();

    const freshSmtp = freshModuleRef.get(SmtpMailService);
    expect(freshSmtp.isAvailable()).toBe(false);
    await expect(freshSmtp.ensureAvailable()).resolves.toBe(false);

    await freshApp.close();
  });
});
