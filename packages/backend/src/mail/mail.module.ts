import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { CryptoModule } from "../crypto/crypto.module.js";
import { NoopMailService } from "./noop-mail.service.js";
import { MAIL } from "./mail.tokens.js";
import { SmtpMailService } from "./smtp-mail.service.js";

/**
 * Provides the MAIL interface token bound to the config-selected implementation.
 * If SMTP_HOST is set → SmtpMailService; otherwise → NoopMailService.
 * No deployment-mode branching - interface selection only (spec §15, rule 03).
 */
@Global()
@Module({
  imports: [ConfigModule, CryptoModule],
  providers: [
    NoopMailService,
    SmtpMailService,
    {
      provide: MAIL,
      useFactory(config: ConfigService, smtp: SmtpMailService, noop: NoopMailService) {
        return config.get("SMTP_HOST") ? smtp : noop;
      },
      inject: [ConfigService, SmtpMailService, NoopMailService],
    },
  ],
  exports: [MAIL, SmtpMailService, NoopMailService],
})
export class MailModule {}
