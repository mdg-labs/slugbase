import { Injectable } from "@nestjs/common";
import type { BillingCheckoutMode, BillingPlan } from "@slugbase/shared-types";

import { ConfigService } from "../../config/config.service.js";

/** Default Team base seats when env is unset (def §5 — config-tunable). */
export const DEFAULT_TEAM_BASE_SEATS = 5;

export interface PlanPriceConfig {
  personalRecurringPriceId: string | null;
  teamRecurringPriceId: string | null;
  teamExtraSeatPriceId: string | null;
  supporterOneTimePriceId: string | null;
}

/**
 * Config-driven plan pricing and seat defaults (spec §12.1, def §6).
 * Amounts live in Stripe / marketing — app logic references price ids only.
 */
@Injectable()
export class PlanConfigService {
  constructor(private readonly config: ConfigService) {}

  getTeamBaseSeats(): number {
    return this.config.get("TEAM_BASE_SEATS");
  }

  getSupporterPromotionEnd(): Date | null {
    const raw = this.config.get("SUPPORTER_PROMOTION_END");
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  isSupporterPromotionActive(at: Date = new Date()): boolean {
    const end = this.getSupporterPromotionEnd();
    if (!end) return true;
    return at <= end;
  }

  getPriceConfig(): PlanPriceConfig {
    return {
      personalRecurringPriceId: this.config.get("STRIPE_PRICE_PERSONAL") ?? null,
      teamRecurringPriceId: this.config.get("STRIPE_PRICE_TEAM") ?? null,
      teamExtraSeatPriceId: this.config.get("STRIPE_PRICE_TEAM_EXTRA_SEAT") ?? null,
      supporterOneTimePriceId: this.config.get("STRIPE_PRICE_SUPPORTER") ?? null,
    };
  }

  /**
   * Returns the Stripe price id for a checkout request, or null when not configured.
   */
  resolveCheckoutPriceId(
    plan: Exclude<BillingPlan, "free">,
    mode: BillingCheckoutMode,
  ): string | null {
    const prices = this.getPriceConfig();
    if (mode === "one_time") {
      return prices.supporterOneTimePriceId;
    }
    if (plan === "personal") {
      return prices.personalRecurringPriceId;
    }
    return prices.teamRecurringPriceId;
  }
}
