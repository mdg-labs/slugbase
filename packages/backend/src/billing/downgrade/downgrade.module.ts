import { Module } from "@nestjs/common";

import { ConfigModule } from "../../config/config.module.js";
import { DowngradeService } from "./downgrade.service.js";

@Module({
  imports: [ConfigModule],
  providers: [DowngradeService],
  exports: [DowngradeService],
})
export class DowngradeModule {}
