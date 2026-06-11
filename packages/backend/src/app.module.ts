import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ThrottlerModule, type ThrottlerModuleOptions } from "@nestjs/throttler";
import { SentryModule, SentryGlobalFilter } from "@sentry/nestjs/setup";

import { RateLimitModule } from "./auth/rate-limit/rate-limit.module.js";
import { ConfigModule } from "./config/config.module.js";
import { ConfigService } from "./config/config.service.js";
import { domainModules } from "./domain-modules.js";
import { HealthModule } from "./health/health.module.js";

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule,
    HealthModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): ThrottlerModuleOptions => ({
        throttlers: [
          {
            name: "ip",
            // In-memory store; distributed store is a Fast-Follow for multi-instance
            ttl: config.get("RATE_LIMIT_LOGIN_TTL_SECONDS") * 1000,
            limit: config.get("RATE_LIMIT_LOGIN_MAX"),
          },
          {
            name: "user-hour",
            ttl: config.get("RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS") * 1000,
            limit: config.get("RATE_LIMIT_TOKEN_CREATION_MAX"),
          },
        ],
      }),
    }),
    RateLimitModule,
    ...domainModules,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
  ],
})
export class AppModule {}
