import { Inject, Injectable } from "@nestjs/common";

import type { AiSettings, UpdateAiSettingsBody } from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";
import { InstanceMetadataRepository } from "../db/instance-metadata.repository.js";
import { DbService } from "../db/db.service.js";

function workspaceAiEnabledKey(workspaceId: string): string {
  return `workspace_ai_enabled:${workspaceId}`;
}

/**
 * Persists the per-workspace AI enable toggle in {@link instanceMetadata} under
 * a workspace-scoped key. Credentials and model come from deployment env only
 * (spec §11.2, §15).
 */
@Injectable()
export class AiSettingsService {
  private readonly metadata: InstanceMetadataRepository;

  constructor(
    @Inject(DbService) dbService: DbService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.metadata = new InstanceMetadataRepository(dbService.getOrm());
  }

  async getSettings(workspaceId: string): Promise<AiSettings> {
    const enabled = await this.isWorkspaceEnabled(workspaceId);
    return this.toPublicSettings(enabled);
  }

  async updateSettings(
    workspaceId: string,
    body: UpdateAiSettingsBody,
  ): Promise<AiSettings> {
    const currentEnabled = await this.isWorkspaceEnabled(workspaceId);
    const enabled = body.enabled !== undefined ? body.enabled : currentEnabled;

    await this.metadata.set(workspaceAiEnabledKey(workspaceId), enabled ? "true" : "false");

    return this.toPublicSettings(enabled);
  }

  async isWorkspaceEnabled(workspaceId: string): Promise<boolean> {
    const stored = await this.metadata.get(workspaceAiEnabledKey(workspaceId));
    return stored === "true";
  }

  private toPublicSettings(enabled: boolean): AiSettings {
    const hasApiKey = Boolean(this.config.get("OPENAI_API_KEY"));
    return {
      provider: hasApiKey ? "openai" : null,
      hasApiKey,
      model: this.config.get("OPENAI_MODEL"),
      enabled,
    };
  }
}
