import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { DbService } from "../src/db/db.service.js";
import { instanceMetadata } from "../src/db/schema/index.js";
import { InvitationsService } from "../src/invitations/invitations.service.js";
import { MailRuntimeService } from "../src/mail/mail-runtime.service.js";
import { SmtpMailService } from "../src/mail/smtp-mail.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("SMTP env transport (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let smtpMail: SmtpMailService;
  let mailRuntime: MailRuntimeService;
  let invitationsService: InvitationsService;
  let teamWorkspaceId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;

    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_mail_env_smtp",
      SMTP_HOST: "smtp.env.test",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USER: "env-user@env.test",
      SMTP_PASS: "env-password",
      SMTP_FROM: "noreply@env.test",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    smtpMail = moduleRef.get(SmtpMailService);
    mailRuntime = moduleRef.get(MailRuntimeService);
    invitationsService = moduleRef.get(InvitationsService);

    const accountsService = moduleRef.get(AccountsService);
    const workspacesService = moduleRef.get(WorkspacesService);

    const owner = await accountsService.registerAccount({
      email: "mail-env-owner@example.com",
      name: "Mail Env Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const teamWs = await workspacesService.createWorkspace(
      { name: "Mail Env Team", slug: "mail-env-team", plan: "team", planSeats: 10 },
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

  it("configures transport from env at construction without DB smtp_settings", async () => {
    expect(smtpMail.isAvailable()).toBe(true);
    await expect(smtpMail.ensureAvailable()).resolves.toBe(true);
  });

  it("does not overwrite env credentials when DB smtp_settings exist", async () => {
    if (!app) {
      throw new Error("app not initialized");
    }

    const reconfigureSpy = vi.spyOn(smtpMail, "reconfigureFromEncrypted");
    const stored = {
      host: "smtp.db-override.test",
      port: 465,
      secure: true,
      user: "db-user@db.test",
      encryptedPass: "cipher",
      from: "db@db.test",
    };

    const db = app.get(DbService);
    const now = Date.now();
    await db
      .getOrm()
      .insert(instanceMetadata)
      .values({ key: "smtp_settings", value: JSON.stringify(stored), updatedAt: now })
      .onConflictDoUpdate({
        target: instanceMetadata.key,
        set: { value: JSON.stringify(stored), updatedAt: now },
      });

    await mailRuntime.hydrateIfNeeded();

    expect(reconfigureSpy).not.toHaveBeenCalled();
    expect(smtpMail.isAvailable()).toBe(true);

    reconfigureSpy.mockRestore();
  });

  it("sends invitation email using env-configured transport", async () => {
    const sendMailSpy = vi
      .spyOn(smtpMail["transport"], "sendMail")
      .mockResolvedValue({ messageId: "env-smtp-test" });

    await invitationsService.createInvitation(teamWorkspaceId, ownerUserId, {
      email: "invited-env@example.com",
      role: "MEMBER",
    });

    expect(sendMailSpy).toHaveBeenCalledOnce();
    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "noreply@env.test",
        to: "invited-env@example.com",
      }),
    );

    sendMailSpy.mockRestore();
  });
});
