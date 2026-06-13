import { Module } from "@nestjs/common";

import { ConfigModule } from "../../config/config.module.js";
import { PlanConfigService } from "./plan-config.service.js";

@Module({
  imports: [ConfigModule],
  providers: [PlanConfigService],
  exports: [PlanConfigService],
})
export class PlansModule {}
