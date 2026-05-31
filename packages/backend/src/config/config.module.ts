import { Global, Module } from "@nestjs/common";

import { ConfigService } from "./config.service.js";
import { APP_CONFIG } from "./config.tokens.js";
import { validateEnvConfig, type AppConfig } from "./env.schema.js";

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => validateEnvConfig(process.env),
    },
    ConfigService,
  ],
  exports: [APP_CONFIG, ConfigService],
})
export class ConfigModule {}
