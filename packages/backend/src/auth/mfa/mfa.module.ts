import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { MfaController } from "./mfa.controller.js";
import { MfaService } from "./mfa.service.js";

@Module({
  imports: [AccountsModule, SessionsModule, WorkspacesModule],
  controllers: [MfaController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
