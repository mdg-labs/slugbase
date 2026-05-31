import { Inject, Injectable } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";

/**
 * Derives whether workspace plan limits entitlements from billing interface
 * selection (spec §11.4–§11.5). Stripe configured → hosted plan gating;
 * absent → self-host no-op billing with full entitlements.
 */
@Injectable()
export class BillingProfileService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  isPlanGatingEnabled(): boolean {
    const stripeKey = this.config.get("STRIPE_SECRET_KEY");
    return typeof stripeKey === "string" && stripeKey.length > 0;
  }
}
