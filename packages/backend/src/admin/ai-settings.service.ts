import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type { CryptoService } from "@slugbase/shared-types";
import type { AiSettings, UpdateAiSettingsBody } from "@slugbase/shared-types";

import { CRYPTO } from "../crypto/crypto.tokens.js";
import { DbService } from "../db/db.service.js";
import type { DrizzleClient } from "../db/dialect/create-client.js";
import { instanceMetadata } from "../db/schema/index.js";

const AI_SETTINGS_KEY = "ai_settings";

interface StoredAiSettings {
  provider: string | null;
  encryptedApiKey: string | null;
  model: string | null;
  enabled: boolean;
}

function defaultSettings(): StoredAiSettings {
  return {
    provider: null,
    encryptedApiKey: null,
    model: null,
    enabled: false,
  };
}

function toPublicSettings(stored: StoredAiSettings): AiSettings {
  return {
    provider: stored.provider as AiSettings["provider"],
    hasApiKey: stored.encryptedApiKey !== null,
    model: stored.model,
    enabled: stored.enabled,
  };
}

/**
 * Persists AI provider settings in {@link instanceMetadata} under key
 * `ai_settings`. The API key is encrypted at rest (spec §11.11).
 * Plain-text credentials are never stored or returned.
 */
@Injectable()
export class AiSettingsService {
  private readonly db: DrizzleClient;

  constructor(
    @Inject(DbService) dbService: DbService,
    @Inject(CRYPTO) private readonly crypto: CryptoService,
  ) {
    this.db = dbService.getOrm();
  }

  async getSettings(): Promise<AiSettings> {
    const rows = await this.db
      .select()
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, AI_SETTINGS_KEY))
      .limit(1);

    if (!rows[0]) {
      return toPublicSettings(defaultSettings());
    }

    const stored = JSON.parse(rows[0].value) as StoredAiSettings;
    return toPublicSettings(stored);
  }

  async updateSettings(body: UpdateAiSettingsBody): Promise<AiSettings> {
    const rows = await this.db
      .select()
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, AI_SETTINGS_KEY))
      .limit(1);

    const current: StoredAiSettings = rows[0]
      ? (JSON.parse(rows[0].value) as StoredAiSettings)
      : defaultSettings();

    const updated: StoredAiSettings = {
      provider: body.provider !== undefined ? (body.provider ?? null) : current.provider,
      encryptedApiKey: this.resolveEncryptedApiKey(body.apiKey, current.encryptedApiKey),
      model: body.model !== undefined ? (body.model ?? null) : current.model,
      enabled: body.enabled !== undefined ? body.enabled : current.enabled,
    };

    const now = Date.now();
    await this.db
      .insert(instanceMetadata)
      .values({ key: AI_SETTINGS_KEY, value: JSON.stringify(updated), updatedAt: now })
      .onConflictDoUpdate({
        target: instanceMetadata.key,
        set: { value: JSON.stringify(updated), updatedAt: now },
      });

    return toPublicSettings(updated);
  }

  private resolveEncryptedApiKey(
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
}
