import { Module, forwardRef } from "@nestjs/common";

import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { SlugsModule } from "../slugs/slugs.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { BulkBookmarksController } from "./bulk/bulk.controller.js";
import { BulkBookmarksService } from "./bulk/bulk.service.js";
import { MetadataModule } from "./metadata/metadata.module.js";
import { BookmarksController } from "./bookmarks.controller.js";
import { BookmarksService } from "./bookmarks.service.js";

@Module({
  imports: [
    EntitlementsModule,
    MetadataModule,
    SessionsModule,
    WorkspacesModule,
    forwardRef(() => SlugsModule),
  ],
  controllers: [BookmarksController, BulkBookmarksController],
  providers: [BookmarksService, BulkBookmarksService],
  exports: [BookmarksService, BulkBookmarksService],
})
export class BookmarksModule {}
