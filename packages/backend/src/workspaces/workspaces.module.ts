import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { TenantGuard } from "./tenant.guard.js";
import { WorkspaceDataGuard } from "./workspace-data.guard.js";
import { WorkspaceMembersController } from "./workspace-members.controller.js";
import { WorkspaceMembersService } from "./workspace-members.service.js";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";

@Module({
  imports: [AccountsModule, SessionsModule, EntitlementsModule],
  controllers: [WorkspacesController, WorkspaceMembersController],
  providers: [WorkspacesService, WorkspaceMembersService, TenantGuard, WorkspaceDataGuard],
  exports: [WorkspacesService, WorkspaceMembersService, TenantGuard, WorkspaceDataGuard],
})
export class WorkspacesModule {}
