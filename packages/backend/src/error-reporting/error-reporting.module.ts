import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { ERROR_REPORTING } from "./error-reporting.tokens.js";
import { NoopErrorReportingService } from "./noop-error-reporting.service.js";
import { SentryErrorReportingService } from "./sentry-error-reporting.service.js";

/**
 * Provides the ERROR_REPORTING interface token bound to the config-selected implementation.
 * If SENTRY_DSN is set → SentryErrorReportingService; otherwise → NoopErrorReportingService.
 * No deployment-mode branching — interface selection only (spec §15, rule 03).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    NoopErrorReportingService,
    SentryErrorReportingService,
    {
      provide: ERROR_REPORTING,
      useFactory(
        config: ConfigService,
        sentry: SentryErrorReportingService,
        noop: NoopErrorReportingService,
      ) {
        return config.get("SENTRY_DSN") ? sentry : noop;
      },
      inject: [ConfigService, SentryErrorReportingService, NoopErrorReportingService],
    },
  ],
  exports: [ERROR_REPORTING, NoopErrorReportingService, SentryErrorReportingService],
})
export class ErrorReportingModule {}
