import { Inject, Injectable } from "@nestjs/common";

import { APP_CONFIG } from "./config.tokens.js";
import type { AppConfig } from "./env.schema.js";

@Injectable()
export class ConfigService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  getAll(): AppConfig {
    return this.config;
  }

  /**
   * Secure flag for Set-Cookie — follows APP_BASE_URL scheme so plain-HTTP
   * self-host installs work in production (spec §14.2). SLUGBASE_E2E_MODE remains
   * an e2e escape hatch for rate limits and other test overrides.
   */
  cookieSecure(): boolean {
    if (process.env.SLUGBASE_E2E_MODE === "true") {
      return false;
    }
    return new URL(this.get("APP_BASE_URL")).protocol === "https:";
  }
}
