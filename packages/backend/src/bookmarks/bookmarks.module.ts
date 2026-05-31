import { Module } from "@nestjs/common";

import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { BookmarksController } from "./bookmarks.controller.js";
import { BookmarksService } from "./bookmarks.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule],
  controllers: [BookmarksController],
  providers: [BookmarksService],
  exports: [BookmarksService],
})
export class BookmarksModule {}
