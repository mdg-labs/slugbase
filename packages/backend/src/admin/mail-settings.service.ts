import { Inject, Injectable } from "@nestjs/common";

import type { CryptoService } from "@slugbase/shared-types";
import type { MailSettings, UpdateMailSettingsBody } from "@slugbase/shared-types";

import { CRYPTO } from "../crypto/crypto.tokens.js";
import { DbService } from "../db/db.service.js";
import { instanceMetadata } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import type { DrizzleClient } from "../db/dialect/create-client.js";
import type { SmtpMailService } from "../mail/smtp-mail.service.js";

const MAIL_SETTINGS_KEY = "smtp_settings";

interface StoredMailSettings {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  encryptedPass: string | null;
  from: string | null;
}

function defaultSettings(): StoredMailSettings {
  return {
    host: null,
    port: null,
    secure: false,
    user: null,
    encryptedPass: null,
    from: null,
  };
}

function toPublicSettings(stored: StoredMailSettings): MailSettings {
  return {
    host: stored.host,
    port: stored.port,
    secure: stored.secure,
    user: stored.user,
    hasPassword: stored.encryptedPass !== null,
    from: stored.from,
  };
}

/**
 * Persists SMTP transport settings in {@link instanceMetadata} under key
 * `smtp_settings`. The password field is encrypted at rest (spec §11.11).
 * Plain-text credentials are never stored or returned.
 */
@Injectable()
export class MailSettingsService {
  private readonly db: DrizzleClient;

  constructor(
    @Inject(DbService) dbService: DbService,
    @Inject(CRYPTO) private readonly crypto: CryptoService,
  ) {
    this.db = dbService.getOrm();
  }

  async getSettings(): Promise<MailSettings> {
    const rows = await this.db
      .select()
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, MAIL_SETTINGS_KEY))
      .limit(1);

    if (!rows[0]) {
      return toPublicSettings(defaultSettings());
    }

    const stored = JSON.parse(rows[0].value) as StoredMailSettings;
    return toPublicSettings(stored);
  }

  async updateSettings(body: UpdateMailSettingsBody): Promise<MailSettings> {
    const rows = await this.db
      .select()
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, MAIL_SETTINGS_KEY))
      .limit(1);

    const current: StoredMailSettings = rows[0]
      ? (JSON.parse(rows[0].value) as StoredMailSettings)
      : defaultSettings();

    const updated: StoredMailSettings = {
      host: body.host !== undefined ? body.host : current.host,
      port: body.port !== undefined ? body.port : current.port,
      secure: body.secure !== undefined ? body.secure : current.secure,
      user: body.user !== undefined ? (body.user ?? null) : current.user,
      encryptedPass: this.resolveEncryptedPass(body.password, current.encryptedPass),
      from: body.from !== undefined ? body.from : current.from,
    };

    const now = Date.now();
    await this.db
      .insert(instanceMetadata)
      .values({ key: MAIL_SETTINGS_KEY, value: JSON.stringify(updated), updatedAt: now })
      .onConflictDoUpdate({
        target: instanceMetadata.key,
        set: { value: JSON.stringify(updated), updatedAt: now },
      });

    return toPublicSettings(updated);
  }

  /**
   * Applies persisted SMTP settings to the live transport (startup + after PATCH).
   */
  async applyToTransport(smtpMail: SmtpMailService): Promise<void> {
    const stored = await this.loadStoredSettings();
    if (!stored?.host) {
      return;
    }

    smtpMail.reconfigureFromEncrypted({
      host: stored.host,
      port: stored.port ?? 587,
      secure: stored.secure,
      user: stored.user ?? undefined,
      encryptedPass: stored.encryptedPass ?? undefined,
      from: stored.from ?? "noreply@localhost",
    });
  }

  async updateSettingsAndApply(
    body: UpdateMailSettingsBody,
    smtpMail: SmtpMailService,
  ): Promise<MailSettings> {
    const settings = await this.updateSettings(body);
    await this.applyToTransport(smtpMail);
    return settings;
  }

  /** Resolves the stored encrypted password from an optional incoming plaintext value. */
  private resolveEncryptedPass(
    incoming: string | null | undefined,
    current: string | null,
  ): string | null {
    if (incoming === undefined) {
      return current;
    }
    if (incoming === null || incoming === "") {
      return null;
    }
    return this.crypto.encrypt(incoming);
  }

  /**
   * Returns decrypted credentials for reconfiguring the SMTP transport.
   * Only called internally; plaintext never leaves this service.
   */
  async getDecryptedCredentials(): Promise<{
    host: string | null;
    port: number | null;
    secure: boolean;
    user: string | undefined;
    pass: string | undefined;
    from: string;
  } | null> {
    const stored = await this.loadStoredSettings();
    if (!stored?.host) return null;

    return {
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      user: stored.user ?? undefined,
      pass: stored.encryptedPass ? this.crypto.decrypt(stored.encryptedPass) : undefined,
      from: stored.from ?? "noreply@localhost",
    };
  }

  private async loadStoredSettings(): Promise<StoredMailSettings | null> {
    const rows = await this.db
      .select()
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, MAIL_SETTINGS_KEY))
      .limit(1);

    if (!rows[0]) {
      return null;
    }

    return JSON.parse(rows[0].value) as StoredMailSettings;
  }
}
