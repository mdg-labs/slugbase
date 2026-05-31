import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { BillingProfileService } from "./billing-profile.service.js";

@Module({
  imports: [ConfigModule],
  providers: [BillingProfileService],
  exports: [BillingProfileService],
})
export class BillingModule {}
