import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module.js";
import { domainModules } from "./domain-modules.js";
import { HealthModule } from "./health/health.module.js";

@Module({
  imports: [ConfigModule, HealthModule, ...domainModules],
})
export class AppModule {}
