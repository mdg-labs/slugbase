import { Global, Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { ConfigModule } from "../config/config.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { BillingApplicationService } from "./billing-application.service.js";
import { BillingController } from "./billing.controller.js";
import { BILLING } from "./billing.tokens.js";
import { BillingProfileService } from "./billing-profile.service.js";
import { PlansModule } from "./plans/plans.module.js";
import { DowngradeModule } from "./downgrade/downgrade.module.js";
import { NoopBillingService } from "./noop-billing.service.js";
import { PricingController } from "./pricing.controller.js";
import { PricingService } from "./pricing.service.js";

/**
 * CE billing module — always binds BILLING to NoopBillingService (spec §11.4).
 * Cloud payment provider wiring lives in slugbase-cloud (TASK-016/017).
 */
@Global()
@Module({
  imports: [ConfigModule, PlansModule, AccountsModule, SessionsModule, DowngradeModule],
  controllers: [BillingController, PricingController],
  providers: [
    NoopBillingService,
    BillingProfileService,
    BillingApplicationService,
    PricingService,
    {
      provide: BILLING,
      useExisting: NoopBillingService,
    },
  ],
  exports: [
    BILLING,
    BillingApplicationService,
    BillingProfileService,
    NoopBillingService,
    PricingService,
    PlansModule,
    DowngradeModule,
  ],
})
export class BillingModule {}
