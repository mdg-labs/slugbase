import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { ConfigService } from "../src/config/config.service.js";
import { validateEnvConfig } from "../src/config/env.schema.js";
import { AesGcmCryptoService } from "../src/crypto/aes-gcm-crypto.service.js";
import { DbService } from "../src/db/db.service.js";
import { instanceMetadata } from "../src/db/schema/index.js";
import { SmtpMailService } from "../src/mail/smtp-mail.service.js";
import { applyTestEnv, clearTestEnv, validTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

async function seedLegacySmtpSettings(databaseUrl: string): Promise<void> {
  const config = new ConfigService(
    validateEnvConfig({
      ...validTestEnv,
      DATABASE_URL: databaseUrl,
    }),
  );
  const crypto = new AesGcmCryptoService(config);
  const stored = {
    host: "smtp.hydration.test",
    port: 587,
    secure: false,
    user: "smtp-user@hydration.test",
    encryptedPass: crypto.encrypt("smtp-password"),
    from: "noreply@hydration.test",
  };

  const { client, close } = await import("../src/db/dialect/create-client.js").then(
    ({ createDbClient }) => createDbClient(databaseUrl),
  );
  const now = Date.now();
  await client
    .insert(instanceMetadata)
    .values({ key: "smtp_settings", value: JSON.stringify(stored), updatedAt: now })
    .onConflictDoUpdate({
      target: instanceMetadata.key,
      set: { value: JSON.stringify(stored), updatedAt: now },
    });
  await close();
}

describe("SMTP transport DB hydration removed (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let smtpMail: SmtpMailService;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await seedLegacySmtpSettings(testDatabase.databaseUrl);

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_mail_hydration",
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
      const db = app.get(DbService);
      await db
        .getOrm()
        .delete(instanceMetadata)
        .where(eq(instanceMetadata.key, "smtp_settings"));
      await app.close();
    }
    clearTestEnv();
    await cleanup();
  });

  it("does not hydrate SMTP from legacy smtp_settings when SMTP_HOST env is absent", () => {
    expect(smtpMail.isAvailable()).toBe(false);
  });

  it("ensureAvailable stays false with only legacy DB smtp_settings", async () => {
    await expect(smtpMail.ensureAvailable()).resolves.toBe(false);
  });

  it("does not become available after legacy settings are inserted post-startup", async () => {
    if (!app) {
      throw new Error("app not initialized");
    }

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

    await seedLegacySmtpSettings(databaseUrl);
    await expect(freshSmtp.ensureAvailable()).resolves.toBe(false);
    expect(freshSmtp.isAvailable()).toBe(false);

    await freshApp.close();
  });
});
