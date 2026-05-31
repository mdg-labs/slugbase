import { Global, Module } from "@nestjs/common";

import { SessionsModule } from "../../sessions/sessions.module.js";
import { IpThrottlerGuard } from "./ip-throttler.guard.js";
import { UserThrottlerGuard } from "./user-throttler.guard.js";

/**
 * Global module that provides IP- and session-scoped throttler guards.
 * Declared global so both guards are injectable in any module without
 * repeated imports. The ThrottlerModule (configured in AppModule) must be
 * imported before this module.
 */
@Global()
@Module({
  imports: [SessionsModule],
  providers: [IpThrottlerGuard, UserThrottlerGuard],
  exports: [IpThrottlerGuard, UserThrottlerGuard],
})
export class RateLimitModule {}
