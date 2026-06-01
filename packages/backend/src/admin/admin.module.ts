import { Module } from "@nestjs/common";

import { CryptoModule } from "../crypto/crypto.module.js";
import { DbModule } from "../db/db.module.js";
import { MailModule } from "../mail/mail.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { MailSettingsController } from "./mail-settings.controller.js";
import { MailSettingsService } from "./mail-settings.service.js";

@Module({
  imports: [DbModule, CryptoModule, MailModule, WorkspacesModule],
  controllers: [MailSettingsController],
  providers: [MailSettingsService],
  exports: [MailSettingsService],
})
export class AdminModule {}
