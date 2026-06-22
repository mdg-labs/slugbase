import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { ConfigService } from "../src/config/config.service.js";
import { validateEnvConfig } from "../src/config/env.schema.js";
import { AesGcmCryptoService } from "../src/crypto/aes-gcm-crypto.service.js";
import { DbService } from "../src/db/db.service.js";
import { instanceMetadata } from "../src/db/schema/index.js";
import { InvitationsService } from "../src/invitations/invitations.service.js";
import { SmtpMailService } from "../src/mail/smtp-mail.service.js";
import { applyTestEnv, clearTestEnv, validTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

async function seedSmtpSettings(databaseUrl: string): Promise<void> {
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

describe("SMTP transport DB hydration (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let smtpMail: SmtpMailService;
  let invitationsService: InvitationsService;
  let teamWorkspaceId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    await seedSmtpSettings(testDatabase.databaseUrl);

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
    invitationsService = moduleRef.get(InvitationsService);

    const accountsService = moduleRef.get(AccountsService);
    const workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: "mail-hydration-owner@example.com",
      name: "Mail Hydration Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const teamWs = await workspacesService.createWorkspace(
      { name: "Mail Hydration Team", slug: "mail-hydration-team", plan: "team", planSeats: 10 },
      ownerUserId,
    );
    teamWorkspaceId = teamWs.id;
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

  it("hydrates SMTP from DB on bootstrap when SMTP_HOST env is absent", () => {
    expect(smtpMail.isAvailable()).toBe(true);
  });

  it("sends invitation email when only DB SMTP settings exist", async () => {
    const sendMailSpy = vi
      .spyOn(smtpMail["transport"], "sendMail")
      .mockResolvedValue({ messageId: "hydration-test" });

    await invitationsService.createInvitation(teamWorkspaceId, ownerUserId, {
      email: "invited-hydration@example.com",
      role: "MEMBER",
    });

    expect(sendMailSpy).toHaveBeenCalledOnce();
    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "noreply@hydration.test",
        to: "invited-hydration@example.com",
      }),
    );

    sendMailSpy.mockRestore();
  });

  it("lazy-hydrates when settings are inserted after startup", async () => {
    if (!app) {
      throw new Error("app not initialized");
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required");
    }

    const db = app.get(DbService);
    await db.getOrm().delete(instanceMetadata).where(eq(instanceMetadata.key, "smtp_settings"));

    const freshModuleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const freshApp = freshModuleRef.createNestApplication();
    await freshApp.init();

    const freshSmtp = freshModuleRef.get(SmtpMailService);
    expect(freshSmtp.isAvailable()).toBe(false);

    await seedSmtpSettings(databaseUrl);
    await expect(freshSmtp.ensureAvailable()).resolves.toBe(true);
    expect(freshSmtp.isAvailable()).toBe(true);

    await freshApp.close();
  });
});
