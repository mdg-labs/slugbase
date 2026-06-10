/** Types matching the public pricing API response (GET /pricing/public). */

export interface PublicPriceInfo {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  type: "recurring" | "one_time";
  display: string;
}

export interface PublicPlanPriceGroup {
  monthly?: PublicPriceInfo;
  annual?: PublicPriceInfo;
}

export interface PricingResponse {
  plans: {
    personal: PublicPlanPriceGroup;
    team: PublicPlanPriceGroup;
    supporter?: PublicPriceInfo;
  };
  teamBaseSeats: number;
  freeBookmarkCap: number;
}
