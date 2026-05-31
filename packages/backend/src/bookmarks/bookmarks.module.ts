import { Module } from "@nestjs/common";

import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { BulkBookmarksController } from "./bulk/bulk.controller.js";
import { BulkBookmarksService } from "./bulk/bulk.service.js";
import { BookmarksController } from "./bookmarks.controller.js";
import { BookmarksService } from "./bookmarks.service.js";

@Module({
  imports: [SessionsModule, WorkspacesModule],
  controllers: [BookmarksController, BulkBookmarksController],
  providers: [BookmarksService, BulkBookmarksService],
  exports: [BookmarksService, BulkBookmarksService],
})
export class BookmarksModule {}
