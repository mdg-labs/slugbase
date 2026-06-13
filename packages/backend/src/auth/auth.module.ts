import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { ApiTokensModule } from "./api-tokens/api-tokens.module.js";
import { AccountController } from "./account/account.controller.js";
import { CsrfModule } from "./csrf/csrf.module.js";
import { LoginLogoutController } from "./login-logout.controller.js";
import { MfaModule } from "./mfa/mfa.module.js";
import { OidcModule } from "./oidc/oidc.module.js";
import { PasswordResetModule } from "./password-reset/password-reset.module.js";
import { RegistrationModule } from "./registration/registration.module.js";
import { EmailVerificationModule } from "./verification/email-verification.module.js";
import { EmailChangeModule } from "./account/email-change.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

@Module({
  imports: [
    CsrfModule,
    AccountsModule,
    SessionsModule,
    WorkspacesModule,
    MfaModule,
    ApiTokensModule,
    EmailVerificationModule,
    EmailChangeModule,
    OidcModule,
    PasswordResetModule,
    RegistrationModule,
  ],
  controllers: [LoginLogoutController, AccountController],
})
export class AuthModule {}
