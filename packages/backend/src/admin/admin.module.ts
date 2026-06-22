import { Module } from "@nestjs/common";

import { CryptoModule } from "../crypto/crypto.module.js";
import { DbModule } from "../db/db.module.js";
import { MailModule } from "../mail/mail.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { AiSettingsController } from "./ai-settings.controller.js";
import { AiSettingsService } from "./ai-settings.service.js";

@Module({
  imports: [DbModule, CryptoModule, MailModule, SessionsModule, WorkspacesModule],
  controllers: [AiSettingsController],
  providers: [AiSettingsService],
  exports: [AiSettingsService],
})
export class AdminModule {}
