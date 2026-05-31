import { Module } from "@nestjs/common";

import { BookmarksModule } from "../bookmarks/bookmarks.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { GoController } from "./go.controller.js";
import { GoService } from "./go.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule, BookmarksModule],
  controllers: [GoController],
  providers: [GoService],
  exports: [GoService],
})
export class SlugsModule {}
