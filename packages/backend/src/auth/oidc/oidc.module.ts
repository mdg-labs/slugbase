import { Module } from "@nestjs/common";

import { AccountsModule } from "../../accounts/accounts.module.js";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { DbModule } from "../../db/db.module.js";
import { SessionsModule } from "../../sessions/sessions.module.js";
import { OidcController } from "./oidc.controller.js";
import { OidcService } from "./oidc.service.js";

@Module({
  imports: [DbModule, CryptoModule, AccountsModule, SessionsModule],
  controllers: [OidcController],
  providers: [OidcService],
  exports: [OidcService],
})
export class OidcModule {}
