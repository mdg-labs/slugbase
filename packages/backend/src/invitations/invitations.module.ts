import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { MailModule } from "../mail/mail.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { InvitationsController } from "./invitations.controller.js";
import { InvitationsService } from "./invitations.service.js";

@Module({
  imports: [AccountsModule, EntitlementsModule, MailModule, SessionsModule, WorkspacesModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
