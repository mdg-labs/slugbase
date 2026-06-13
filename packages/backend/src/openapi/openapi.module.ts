import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { OpenapiController } from "./openapi.controller.js";
import { OpenapiService } from "./openapi.service.js";

@Module({
  imports: [ConfigModule],
  controllers: [OpenapiController],
  providers: [OpenapiService],
})
export class OpenapiModule {}
