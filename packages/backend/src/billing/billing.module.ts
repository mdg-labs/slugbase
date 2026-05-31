import { Global, Module } from "@nestjs/common";
import Stripe from "stripe";

import { AccountsModule } from "../accounts/accounts.module.js";
import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import {
  BillingApplicationService,
  STRIPE_WEBHOOK_CLIENT,
  type StripeWebhookClient,
} from "./billing-application.service.js";
import { BillingController } from "./billing.controller.js";
import { BILLING, STRIPE_CLIENT } from "./billing.tokens.js";
import { BillingProfileService } from "./billing-profile.service.js";
import { PlansModule } from "./plans/plans.module.js";
import { DowngradeModule } from "./downgrade/downgrade.module.js";
import { NoopBillingService } from "./noop-billing.service.js";
import { StripeBillingService, type StripeBillingClient } from "./stripe-billing.service.js";

/**
 * Provides the BILLING interface token bound to the config-selected implementation.
 * If STRIPE_SECRET_KEY is set → StripeBillingService; otherwise → NoopBillingService.
 * No deployment-mode branching — interface selection only (spec §15, rule 03).
 */
@Global()
@Module({
  imports: [ConfigModule, PlansModule, AccountsModule, SessionsModule, DowngradeModule],
  controllers: [BillingController],
  providers: [
    NoopBillingService,
    StripeBillingService,
    BillingProfileService,
    BillingApplicationService,
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
      provide: STRIPE_WEBHOOK_CLIENT,
      useFactory: (config: ConfigService): StripeWebhookClient => {
        const secretKey = config.get("STRIPE_SECRET_KEY");
        if (!secretKey) {
          return createUnavailableWebhookClient();
        }
        return new Stripe(secretKey);
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
  exports: [
    BILLING,
    BillingApplicationService,
    BillingProfileService,
    NoopBillingService,
    StripeBillingService,
    PlansModule,
    DowngradeModule,
  ],
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

function createUnavailableWebhookClient(): StripeWebhookClient {
  return {
    webhooks: {
      constructEvent: (): never => {
        throw new Error("Stripe webhook client requested without STRIPE_SECRET_KEY");
      },
    },
  };
}
