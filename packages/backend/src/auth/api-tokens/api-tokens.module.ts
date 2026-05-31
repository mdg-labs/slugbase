import { Module } from "@nestjs/common";

import { DbModule } from "../../db/db.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { ApiTokenController } from "./api-token.controller.js";
import { ApiTokenService } from "./api-token.service.js";
import { BearerAuthGuard } from "./bearer-auth.guard.js";

@Module({
  imports: [DbModule, SessionsModule],
  controllers: [ApiTokenController],
  providers: [ApiTokenService, BearerAuthGuard],
  exports: [ApiTokenService, BearerAuthGuard],
})
export class ApiTokensModule {}
