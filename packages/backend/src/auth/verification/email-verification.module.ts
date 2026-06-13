import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { EmailChangeModule } from "../account/email-change.module.js";
import { EmailVerificationController } from "./email-verification.controller.js";
import { EmailVerificationService } from "./email-verification.service.js";

@Module({
  imports: [AccountsModule, SessionsModule, EmailChangeModule],
  controllers: [EmailVerificationController],
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}
