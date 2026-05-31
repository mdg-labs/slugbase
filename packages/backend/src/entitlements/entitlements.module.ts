import { Module } from "@nestjs/common";

import { BillingModule } from "../billing/billing.module.js";
import { EntitlementsService } from "./entitlements.service.js";

@Module({
  imports: [BillingModule],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
