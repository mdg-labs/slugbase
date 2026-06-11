import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { DbModule } from "../db/db.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsConsentService } from "./analytics-consent.service.js";
import { ANALYTICS, UMAMI_HTTP } from "./analytics.tokens.js";
import { NoopAnalyticsService } from "./noop-analytics.service.js";
import { UmamiAnalyticsService } from "./umami-analytics.service.js";

/**
 * Provides the ANALYTICS interface token bound to the config-selected implementation.
 * If UMAMI_HOST and UMAMI_WEBSITE_ID are set → UmamiAnalyticsService; otherwise → NoopAnalyticsService.
 * No deployment-mode branching - interface selection only (spec §11.6, §15).
 */
@Global()
@Module({
  imports: [ConfigModule, DbModule, SessionsModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsConsentService,
    NoopAnalyticsService,
    UmamiAnalyticsService,
    {
      provide: UMAMI_HTTP,
      useValue: (input: string, init?: RequestInit) => fetch(input, init),
    },
    {
      provide: ANALYTICS,
      useFactory(
        config: ConfigService,
        umami: UmamiAnalyticsService,
        noop: NoopAnalyticsService,
      ) {
        return config.get("UMAMI_HOST") && config.get("UMAMI_WEBSITE_ID")
          ? umami
          : noop;
      },
      inject: [ConfigService, UmamiAnalyticsService, NoopAnalyticsService],
    },
  ],
  exports: [
    ANALYTICS,
    AnalyticsConsentService,
    NoopAnalyticsService,
    UmamiAnalyticsService,
  ],
})
export class AnalyticsModule {}
