import { Module, forwardRef } from "@nestjs/common";

import { BookmarksModule } from "../bookmarks/bookmarks.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { GoController } from "./go.controller.js";
import { GoService } from "./go.service.js";
import { GO_SERVICE } from "./go.tokens.js";

@Module({
  imports: [SessionsModule, WorkspacesModule, forwardRef(() => BookmarksModule)],
  controllers: [GoController],
  providers: [GoService, { provide: GO_SERVICE, useExisting: GoService }],
  exports: [GoService, GO_SERVICE],
})
export class SlugsModule {}
