import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { AuditController } from "./audit.controller.js";
import { AuditService } from "./audit.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule, EntitlementsModule, AccountsModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
