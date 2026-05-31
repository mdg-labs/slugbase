import { Global, Module } from "@nestjs/common";
import Stripe from "stripe";

import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { BILLING, STRIPE_CLIENT } from "./billing.tokens.js";
import { BillingProfileService } from "./billing-profile.service.js";
import { PlansModule } from "./plans/plans.module.js";
import { NoopBillingService } from "./noop-billing.service.js";
import { StripeBillingService, type StripeBillingClient } from "./stripe-billing.service.js";

/**
 * Provides the BILLING interface token bound to the config-selected implementation.
 * If STRIPE_SECRET_KEY is set → StripeBillingService; otherwise → NoopBillingService.
 * No deployment-mode branching — interface selection only (spec §15, rule 03).
 */
@Global()
@Module({
  imports: [ConfigModule, PlansModule],
  providers: [
    NoopBillingService,
    StripeBillingService,
    BillingProfileService,
    {
      provide: STRIPE_CLIENT,
      useFactory: (config: ConfigService): StripeBillingClient => {
        const secretKey = config.get("STRIPE_SECRET_KEY");
        if (!secretKey) {
          return createUnavailableStripeClient();
        }
        return new Stripe(secretKey) as unknown as StripeBillingClient;
      },
      inject: [ConfigService],
    },
    {
      provide: BILLING,
      useFactory(
        config: ConfigService,
        stripe: StripeBillingService,
        noop: NoopBillingService,
      ) {
        return config.get("STRIPE_SECRET_KEY") ? stripe : noop;
      },
      inject: [ConfigService, StripeBillingService, NoopBillingService],
    },
  ],
  exports: [BILLING, BillingProfileService, NoopBillingService, StripeBillingService, PlansModule],
})
export class BillingModule {}

function createUnavailableStripeClient(): StripeBillingClient {
  const unavailable = (): never => {
    throw new Error("Stripe client requested without STRIPE_SECRET_KEY");
  };
  return {
    checkout: { sessions: { create: unavailable } },
    billingPortal: { sessions: { create: unavailable } },
    subscriptions: { retrieve: unavailable, update: unavailable },
  };
}
