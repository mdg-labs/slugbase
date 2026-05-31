import { Global, Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { AuthzService } from "../common/authz/authz.service.js";
import { DbModule } from "../db/db.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { SharingController } from "./sharing.controller.js";
import { SharingService } from "./sharing.service.js";

@Global()
@Module({
  imports: [DbModule, SessionsModule, WorkspacesModule, AccountsModule, EntitlementsModule],
  controllers: [SharingController],
  providers: [AuthzService, SharingService],
  exports: [AuthzService, SharingService],
})
export class SharingModule {}
