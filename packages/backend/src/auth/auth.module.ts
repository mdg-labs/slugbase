import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { CsrfModule } from "./csrf/csrf.module.js";
import { LoginLogoutController } from "./login-logout.controller.js";
import { MfaModule } from "./mfa/mfa.module.js";

@Module({
  imports: [CsrfModule, AccountsModule, SessionsModule, MfaModule],
  controllers: [LoginLogoutController],
})
export class AuthModule {}
