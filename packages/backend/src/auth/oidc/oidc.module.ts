import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { DbModule } from "../../db/db.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { OidcAdminController } from "./oidc-admin.controller.js";
import { OidcController } from "./oidc.controller.js";
import { OidcService } from "./oidc.service.js";

@Module({
  imports: [DbModule, CryptoModule, AccountsModule, SessionsModule, WorkspacesModule],
  controllers: [OidcController, OidcAdminController],
  providers: [OidcService],
  exports: [OidcService],
})
export class OidcModule {}
