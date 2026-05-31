import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { PasswordResetController } from "./password-reset.controller.js";
import { PasswordResetService } from "./password-reset.service.js";

@Module({
  imports: [AccountsModule, SessionsModule],
  controllers: [PasswordResetController],
  providers: [PasswordResetService],
  exports: [PasswordResetService],
})
export class PasswordResetModule {}
