import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { EmailVerificationModule } from "../auth/verification/email-verification.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { SetupController } from "./setup.controller.js";
import { SetupService } from "./setup.service.js";

@Module({
  imports: [AccountsModule, SessionsModule, WorkspacesModule, EmailVerificationModule],
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
