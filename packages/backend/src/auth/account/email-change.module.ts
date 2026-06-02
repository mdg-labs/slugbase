import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { MailModule } from "../../mail/mail.module.js";
import { EmailChangeService } from "./email-change.service.js";

@Module({
  imports: [AccountsModule, MailModule],
  providers: [EmailChangeService],
  exports: [EmailChangeService],
})
export class EmailChangeModule {}
