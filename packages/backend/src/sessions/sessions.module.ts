import { Module } from "@nestjs/common";

import { SessionGuard } from "./session.guard.js";
import { SessionService } from "./session.service.js";

@Module({
  providers: [SessionService, SessionGuard],
  exports: [SessionService, SessionGuard],
})
export class SessionsModule {}
