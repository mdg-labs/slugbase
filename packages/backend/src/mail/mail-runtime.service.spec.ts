import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import type { DbService } from "../db/db.service.js";
import { MailRuntimeService } from "./mail-runtime.service.js";
import type { SmtpMailService } from "./smtp-mail.service.js";

function createDbService(rows: Array<{ value: string }>): MockedObject<DbService> {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return {
    getOrm: vi.fn().mockReturnValue({ select }),
  } as unknown as MockedObject<DbService>;
}

function createConfig(smtpHost?: string): ConfigService {
  return {
    get: (key: string) => (key === "SMTP_HOST" ? smtpHost : undefined),
  } as ConfigService;
}

function createSmtpMail(available = false): MockedObject<SmtpMailService> {
  let configured = available;
  return {
    isAvailable: vi.fn(() => configured),
    reconfigureFromEncrypted: vi.fn(() => {
      configured = true;
    }),
  } as unknown as MockedObject<SmtpMailService>;
}

describe("MailRuntimeService", () => {
  it("applies DB settings on bootstrap when env SMTP_HOST is absent", async () => {
    const smtpMail = createSmtpMail(false);
    const stored = {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user@example.com",
      encryptedPass: "cipher",
      from: "noreply@example.com",
    };
    const service = new MailRuntimeService(
      createConfig(undefined),
      createDbService([{ value: JSON.stringify(stored) }]),
      smtpMail,
    );

    await service.onModuleInit();

    expect(smtpMail.reconfigureFromEncrypted).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user@example.com",
      encryptedPass: "cipher",
      from: "noreply@example.com",
    });
    expect(smtpMail.isAvailable()).toBe(true);
  });

  it("skips DB settings when env SMTP_HOST is set at startup", async () => {
    const smtpMail = createSmtpMail(true);
    const stored = {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user@example.com",
      encryptedPass: "cipher",
      from: "noreply@example.com",
    };
    const service = new MailRuntimeService(
      createConfig("env-smtp.example.com"),
      createDbService([{ value: JSON.stringify(stored) }]),
      smtpMail,
    );

    await service.onModuleInit();

    expect(smtpMail.reconfigureFromEncrypted).not.toHaveBeenCalled();
  });

  it("hydrates lazily from DB when transport is still unavailable", async () => {
    const smtpMail = createSmtpMail(false);
    const stored = {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user@example.com",
      encryptedPass: "cipher",
      from: "noreply@example.com",
    };
    const service = new MailRuntimeService(
      createConfig(undefined),
      createDbService([{ value: JSON.stringify(stored) }]),
      smtpMail,
    );

    const available = await service.hydrateIfNeeded();

    expect(available).toBe(true);
    expect(smtpMail.reconfigureFromEncrypted).toHaveBeenCalledOnce();
  });

  it("returns false when no DB settings exist", async () => {
    const smtpMail = createSmtpMail(false);
    const service = new MailRuntimeService(
      createConfig(undefined),
      createDbService([]),
      smtpMail,
    );

    const available = await service.hydrateIfNeeded();

    expect(available).toBe(false);
    expect(smtpMail.reconfigureFromEncrypted).not.toHaveBeenCalled();
  });
});
