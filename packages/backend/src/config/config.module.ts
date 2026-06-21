import { Global, Module } from "@nestjs/common";

import { ConfigService } from "./config.service.js";
import { APP_CONFIG } from "./config.tokens.js";
import { loadAppConfig } from "./load-config.js";
import type { AppConfig } from "./env.schema.js";

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadAppConfig(process.env),
    },
    ConfigService,
  ],
  exports: [APP_CONFIG, ConfigService],
})
export class ConfigModule {}
