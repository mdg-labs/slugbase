import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { ConfigService } from "../config/config.service.js";
import { DbService } from "../db/db.service.js";
import type { DrizzleClient } from "../db/dialect/create-client.js";
import { instanceMetadata } from "../db/schema/index.js";
import { OpenAiAiService } from "./openai-ai.service.js";

const AI_SETTINGS_KEY = "ai_settings";

export interface StoredAiSettings {
  provider: string | null;
  encryptedApiKey: string | null;
  model: string | null;
  enabled: boolean;
}

function defaultStoredSettings(): StoredAiSettings {
  return {
    provider: null,
    encryptedApiKey: null,
    model: null,
    enabled: false,
  };
}

/**
 * Applies instance AI settings from {@link instanceMetadata} to the live OpenAI
 * service. Deployment env credentials take precedence at startup when set; DB
 * settings apply when `OPENAI_API_KEY` is absent (spec §11.2, §15).
 */
@Injectable()
export class AiRuntimeService implements OnModuleInit {
  private readonly db: DrizzleClient;
  private instanceEnabled = false;
  private envCredentialsActive = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DbService) dbService: DbService,
    @Inject(OpenAiAiService) private readonly openAi: OpenAiAiService,
  ) {
    this.db = dbService.getOrm();
  }

  async onModuleInit(): Promise<void> {
    this.envCredentialsActive = Boolean(this.config.get("OPENAI_API_KEY"));
    const stored = await this.loadStoredSettings();
    this.applyStoredSettings(stored);
  }

  isInstanceEnabled(): boolean {
    return this.instanceEnabled;
  }

  applyStoredSettings(stored: StoredAiSettings): void {
    this.instanceEnabled = stored.enabled;
    this.applyCredentials(stored);
  }

  private applyCredentials(stored: StoredAiSettings): void {
    if (this.envCredentialsActive) {
      return;
    }

    if (stored.enabled && stored.encryptedApiKey) {
      this.openAi.reconfigureFromEncrypted(
        stored.encryptedApiKey,
        stored.model ?? undefined,
      );
      return;
    }

    this.openAi.clearCredentials();
  }

  private async loadStoredSettings(): Promise<StoredAiSettings> {
    const rows = await this.db
      .select()
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, AI_SETTINGS_KEY))
      .limit(1);

    if (!rows[0]) {
      return defaultStoredSettings();
    }

    return JSON.parse(rows[0].value) as StoredAiSettings;
  }
}
