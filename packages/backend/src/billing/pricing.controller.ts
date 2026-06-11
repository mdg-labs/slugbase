import { Controller, Get, Header, HttpCode, Inject } from "@nestjs/common";

import type { PricingResponse } from "./pricing.service.js";
import { PricingService } from "./pricing.service.js";

const CACHE_CONTROL = "public, max-age=300";

/**
 * Public pricing endpoint - no auth, no CSRF.
 * Returns structured price data from Stripe price IDs (spec §12.1, issue #310).
 * CORS is handled globally (FRONTEND_ORIGIN + marketing origin).
 */
@Controller()
export class PricingController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Get("pricing/public")
  @HttpCode(200)
  @Header("Cache-Control", CACHE_CONTROL)
  async getPublicPricing(): Promise<PricingResponse> {
    return this.pricing.getPricing();
  }
}
