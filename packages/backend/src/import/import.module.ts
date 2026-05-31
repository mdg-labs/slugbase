import { Module } from "@nestjs/common";

import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";

@Module({
  imports: [EntitlementsModule, SessionsModule, WorkspacesModule],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
