import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { TeamsController } from "./teams.controller.js";
import { TeamsService } from "./teams.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule, AuditModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
