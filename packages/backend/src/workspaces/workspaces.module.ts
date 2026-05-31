import { Module } from "@nestjs/common";

import { SessionsModule } from "../sessions/sessions.module.js";
import { TenantGuard } from "./tenant.guard.js";
import { WorkspaceMembersService } from "./workspace-members.service.js";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";

@Module({
  imports: [SessionsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceMembersService, TenantGuard],
  exports: [WorkspacesService, WorkspaceMembersService, TenantGuard],
})
export class WorkspacesModule {}
