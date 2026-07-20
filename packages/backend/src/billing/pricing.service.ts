import { Injectable } from "@nestjs/common";

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

const FREE_BOOKMARK_CAP = 50;
const TEAM_BASE_SEATS = 5;

/**
 * Public pricing response for CE — no live payment provider (spec §12.1).
 * Cloud deployments serve live prices from slugbase-cloud billing.
 */
@Injectable()
export class PricingService {
  isAvailable(): boolean {
    return false;
  }

  getPricing(): Promise<PricingResponse> {
    return Promise.resolve({
      plans: {
        personal: {},
        team: {},
      },
      teamBaseSeats: TEAM_BASE_SEATS,
      freeBookmarkCap: FREE_BOOKMARK_CAP,
    });
  }
}
