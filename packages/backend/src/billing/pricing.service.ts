import { Inject, Injectable, Logger } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";
import { STRIPE_CLIENT } from "./billing.tokens.js";
import type { StripePriceLike } from "./stripe-billing.mapper.js";
import type { StripeBillingClient } from "./stripe-billing.service.js";

export interface PriceInfo {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  type: "recurring" | "one_time";
  display: string;
}

export interface PlanPriceGroup {
  monthly?: PriceInfo;
  annual?: PriceInfo;
}

export interface PricingResponse {
  plans: {
    personal: PlanPriceGroup;
    team: PlanPriceGroup;
    supporter?: PriceInfo;
  };
  teamBaseSeats: number;
  freeBookmarkCap: number;
}

/** Formats a Stripe unit amount (cents) into a locale-aware display string. */
function formatDisplayPrice(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: unitAmount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(unitAmount / 100);
}

const FREE_BOOKMARK_CAP = 50;
const TEAM_BASE_SEATS = 5;

/**
 * Fetches live prices from Stripe and builds the public pricing response.
 * Config-driven: STRIPE_PRICE_* env vars provide the price IDs;
 * amounts/interval come from Stripe itself (spec §12.1, §15).
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeBillingClient,
  ) {}

  isAvailable(): boolean {
    const key = this.config.get("STRIPE_SECRET_KEY");
    return typeof key === "string" && key.length > 0;
  }

  async getPricing(): Promise<PricingResponse> {
    const prices = await this.fetchAllPrices();

    return {
      plans: {
        personal: {
          monthly: prices.personalMonthly,
          annual: prices.personalAnnual,
        },
        team: {
          monthly: prices.teamMonthly,
          annual: prices.teamAnnual,
        },
        supporter: prices.supporter,
      },
      teamBaseSeats: TEAM_BASE_SEATS,
      freeBookmarkCap: FREE_BOOKMARK_CAP,
    };
  }

  private async fetchAllPrices(): Promise<{
    personalMonthly: PriceInfo | undefined;
    personalAnnual: PriceInfo | undefined;
    teamMonthly: PriceInfo | undefined;
    teamAnnual: PriceInfo | undefined;
    supporter: PriceInfo | undefined;
  }> {
    const priceIds = [
      { key: "personalMonthly", id: this.config.get("STRIPE_PRICE_PERSONAL_MONTHLY") },
      { key: "personalAnnual", id: this.config.get("STRIPE_PRICE_PERSONAL_ANNUAL") },
      { key: "teamMonthly", id: this.config.get("STRIPE_PRICE_TEAM_MONTHLY") },
      { key: "teamAnnual", id: this.config.get("STRIPE_PRICE_TEAM_ANNUAL") },
      { key: "supporter", id: this.config.get("STRIPE_PRICE_SUPPORTER") },
    ] as const;

    const results: Record<string, PriceInfo | undefined> = {};

    for (const { key, id } of priceIds) {
      if (!id) {
        results[key] = undefined;
        continue;
      }

      try {
        const stripePrice = await this.stripe.prices.retrieve(id);
        results[key] = mapPriceInfo(id, stripePrice);
      } catch (error) {
        this.logger.error("Failed to fetch Stripe price", {
          priceKey: key,
          priceId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new PricingFetchError(`Failed to fetch price ${key} (${id})`);
      }
    }

    return results as {
      personalMonthly: PriceInfo | undefined;
      personalAnnual: PriceInfo | undefined;
      teamMonthly: PriceInfo | undefined;
      teamAnnual: PriceInfo | undefined;
      supporter: PriceInfo | undefined;
    };
  }
}

function mapPriceInfo(priceId: string, stripePrice: StripePriceLike): PriceInfo {
  const unitAmount = stripePrice.unit_amount ?? 0;
  const currency = stripePrice.currency;
  const interval = stripePrice.recurring?.interval ?? null;
  const type = stripePrice.type;

  return {
    priceId,
    unitAmount,
    currency,
    interval,
    type,
    display: formatDisplayPrice(unitAmount, currency),
  };
}

export class PricingFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingFetchError";
  }
}
