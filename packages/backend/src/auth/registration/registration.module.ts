import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { EmailVerificationModule } from "../verification/email-verification.module.js";
import { RegistrationController } from "./registration.controller.js";
import { RegistrationService } from "./registration.service.js";

@Module({
  imports: [AccountsModule, SessionsModule, WorkspacesModule, EmailVerificationModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
  exports: [RegistrationService],
})
export class RegistrationModule {}
