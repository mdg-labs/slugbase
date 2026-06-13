import { Module } from "@nestjs/common";

import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { ExportController } from "./export.controller.js";
import { ExportService } from "./export.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
