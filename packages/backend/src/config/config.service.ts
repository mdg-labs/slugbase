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

  /** Secure flag for Set-Cookie — disabled in e2e (plain HTTP on localhost). */
  cookieSecure(): boolean {
    if (process.env.SLUGBASE_E2E_MODE === "true") {
      return false;
    }
    return this.get("isProduction");
  }
}
