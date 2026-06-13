import { Module } from "@nestjs/common";

import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { FoldersController } from "./folders.controller.js";
import { FoldersService } from "./folders.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
