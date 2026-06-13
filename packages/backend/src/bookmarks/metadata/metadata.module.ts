import { Module } from "@nestjs/common";

import { FetchModule } from "../../fetch/fetch.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { FaviconController, MetadataController } from "./metadata.controller.js";
import { MetadataService } from "./metadata.service.js";

@Module({
  imports: [FetchModule, SessionsModule, WorkspacesModule],
  controllers: [MetadataController, FaviconController],
  providers: [MetadataService],
  exports: [MetadataService],
})
export class MetadataModule {}
