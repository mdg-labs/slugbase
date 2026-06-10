import { Inject, Injectable } from "@nestjs/common";
import type { BillingCheckoutMode, BillingInterval, BillingPlan } from "@slugbase/shared-types";

import { ConfigService } from "../../config/config.service.js";

/** Default Team base seats when env is unset (def §5 — config-tunable). */
export const DEFAULT_TEAM_BASE_SEATS = 5;

export interface PlanPriceConfig {
  personalMonthlyPriceId: string | null;
  personalAnnualPriceId: string | null;
  teamMonthlyPriceId: string | null;
  teamAnnualPriceId: string | null;
  teamExtraSeatMonthlyPriceId: string | null;
  teamExtraSeatAnnualPriceId: string | null;
  supporterOneTimePriceId: string | null;
}

/**
 * Config-driven plan pricing and seat defaults (spec §12.1, def §6).
 * Amounts live in Stripe / marketing — app logic references price ids only.
 */
@Injectable()
export class PlanConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

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
      personalMonthlyPriceId: this.config.get("STRIPE_PRICE_PERSONAL_MONTHLY") ?? null,
      personalAnnualPriceId: this.config.get("STRIPE_PRICE_PERSONAL_ANNUAL") ?? null,
      teamMonthlyPriceId: this.config.get("STRIPE_PRICE_TEAM_MONTHLY") ?? null,
      teamAnnualPriceId: this.config.get("STRIPE_PRICE_TEAM_ANNUAL") ?? null,
      teamExtraSeatMonthlyPriceId: this.config.get("STRIPE_PRICE_TEAM_EXTRA_SEAT_MONTHLY") ?? null,
      teamExtraSeatAnnualPriceId: this.config.get("STRIPE_PRICE_TEAM_EXTRA_SEAT_ANNUAL") ?? null,
      supporterOneTimePriceId: this.config.get("STRIPE_PRICE_SUPPORTER") ?? null,
    };
  }

  /**
   * Returns the Stripe price id for a checkout request, or null when not configured.
   * Default interval is 'monthly' when not specified.
   */
  resolveCheckoutPriceId(
    plan: Exclude<BillingPlan, "free">,
    mode: BillingCheckoutMode,
    interval: BillingInterval = "monthly",
  ): string | null {
    const prices = this.getPriceConfig();
    if (mode === "one_time") {
      return prices.supporterOneTimePriceId;
    }
    if (plan === "personal") {
      return interval === "annual"
        ? prices.personalAnnualPriceId
        : prices.personalMonthlyPriceId;
    }
    return interval === "annual"
      ? prices.teamAnnualPriceId
      : prices.teamMonthlyPriceId;
  }

  /**
   * Returns the extra-seat price id for a given interval, or null when not configured.
   */
  getExtraSeatPriceId(interval: BillingInterval = "monthly"): string | null {
    const prices = this.getPriceConfig();
    return interval === "annual"
      ? prices.teamExtraSeatAnnualPriceId
      : prices.teamExtraSeatMonthlyPriceId;
  }
}
