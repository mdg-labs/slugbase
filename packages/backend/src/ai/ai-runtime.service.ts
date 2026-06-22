import { Inject, Injectable } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";

/**
 * Reports deployment env AI configuration. Credentials and model are supplied
 * only via OPENAI_API_KEY / OPENAI_MODEL (spec §11.2, §15).
 */
@Injectable()
export class AiRuntimeService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  isEnvConfigured(): boolean {
    return Boolean(this.config.get("OPENAI_API_KEY"));
  }

  getConfiguredModel(): string {
    return this.config.get("OPENAI_MODEL");
  }
}
