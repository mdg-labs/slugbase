import { Module } from "@nestjs/common";

import { BookmarksModule } from "../bookmarks/bookmarks.module.js";
import { FoldersModule } from "../folders/folders.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { TagsModule } from "../tags/tags.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { SearchController } from "./search.controller.js";
import { SearchService } from "./search.service.js";

@Module({
  imports: [
    SessionsModule,
    WorkspacesModule,
    BookmarksModule,
    FoldersModule,
    TagsModule,
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
