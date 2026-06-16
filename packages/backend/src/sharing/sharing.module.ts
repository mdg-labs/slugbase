import { Global, Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { AuthzService } from "../common/authz/authz.service.js";
import { DbModule } from "../db/db.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { SlugsModule } from "../slugs/slugs.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { SharingController } from "./sharing.controller.js";
import { SharingService } from "./sharing.service.js";
import { SharingSummaryService } from "./sharing-summary.service.js";

@Global()
@Module({
  imports: [DbModule, SessionsModule, WorkspacesModule, AccountsModule, EntitlementsModule, SlugsModule],
  controllers: [SharingController],
  providers: [AuthzService, SharingService, SharingSummaryService],
  exports: [AuthzService, SharingService, SharingSummaryService],
})
export class SharingModule {}
