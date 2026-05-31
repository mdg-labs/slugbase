import { Inject, Injectable } from "@nestjs/common";
import type { BillingService } from "@slugbase/shared-types";

import { BILLING } from "./billing.tokens.js";

/**
 * Derives whether workspace plan limits entitlements from billing interface
 * selection (spec §11.4–§11.5). Stripe configured → hosted plan gating;
 * absent → self-host no-op billing with full entitlements.
 */
@Injectable()
export class BillingProfileService {
  constructor(@Inject(BILLING) private readonly billing: BillingService) {}

  isPlanGatingEnabled(): boolean {
    return this.billing.isPlanGatingEnabled();
  }
}
