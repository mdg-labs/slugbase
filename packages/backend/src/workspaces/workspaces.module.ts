import { Module } from "@nestjs/common";

import { WorkspaceMembersService } from "./workspace-members.service.js";
import { WorkspacesService } from "./workspaces.service.js";

@Module({
  providers: [WorkspacesService, WorkspaceMembersService],
  exports: [WorkspacesService, WorkspaceMembersService],
})
export class WorkspacesModule {}
