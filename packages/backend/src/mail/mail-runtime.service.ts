import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { ConfigService } from "../config/config.service.js";
import { DbService } from "../db/db.service.js";
import type { DrizzleClient } from "../db/dialect/create-client.js";
import { instanceMetadata } from "../db/schema/index.js";
import type { MailTransportHydrator } from "./mail-transport-hydrator.js";
import { SmtpMailService } from "./smtp-mail.service.js";

const MAIL_SETTINGS_KEY = "smtp_settings";

interface StoredMailSettings {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  encryptedPass: string | null;
  from: string | null;
}

/**
 * Applies instance SMTP settings from {@link instanceMetadata} to the live
 * transport. Deployment env credentials take precedence at startup when set; DB
 * settings apply when `SMTP_HOST` is absent (spec §11.1, §15).
 */
@Injectable()
export class MailRuntimeService implements OnModuleInit, MailTransportHydrator {
  private readonly logger = new Logger(MailRuntimeService.name);
  private readonly db: DrizzleClient;
  private envCredentialsActive = false;
  private hydrationPromise: Promise<boolean> | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DbService) dbService: DbService,
    @Inject(SmtpMailService) private readonly smtpMail: SmtpMailService,
  ) {
    this.db = dbService.getOrm();
  }

  async onModuleInit(): Promise<void> {
    this.envCredentialsActive = Boolean(this.config.get("SMTP_HOST"));
    await this.hydrateIfNeeded();
  }

  async hydrateIfNeeded(): Promise<boolean> {
    if (this.envCredentialsActive || this.smtpMail.isAvailable()) {
      return this.smtpMail.isAvailable();
    }

    if (!this.hydrationPromise) {
      this.hydrationPromise = this.loadAndApplyFromDb().finally(() => {
        if (!this.smtpMail.isAvailable()) {
          this.hydrationPromise = undefined;
        }
      });
    }

    return this.hydrationPromise;
  }

  private async loadAndApplyFromDb(): Promise<boolean> {
    const stored = await this.loadStoredSettings();
    if (!stored?.host) {
      return false;
    }

    const wasAvailable = this.smtpMail.isAvailable();
    this.smtpMail.reconfigureFromEncrypted({
      host: stored.host,
      port: stored.port ?? 587,
      secure: stored.secure,
      user: stored.user ?? undefined,
      encryptedPass: stored.encryptedPass ?? undefined,
      from: stored.from ?? "noreply@localhost",
    });

    if (!wasAvailable && this.smtpMail.isAvailable()) {
      this.logger.log("SMTP transport hydrated from database settings");
    }

    return this.smtpMail.isAvailable();
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
