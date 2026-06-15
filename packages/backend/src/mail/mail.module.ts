import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { CryptoModule } from "../crypto/crypto.module.js";
import { NoopMailService } from "./noop-mail.service.js";
import { MAIL } from "./mail.tokens.js";
import { SmtpMailService } from "./smtp-mail.service.js";

/**
 * Provides the MAIL interface token bound to {@link SmtpMailService}.
 * Env `SMTP_*` vars configure the transport at construction; DB-backed workspace
 * settings apply via {@link SmtpMailService.reconfigureFromEncrypted} on startup
 * and after admin PATCH (spec §11.1, §15). Unconfigured transport reports
 * unavailable and degrades gracefully on send.
 */
@Global()
@Module({
  imports: [ConfigModule, CryptoModule],
  providers: [
    NoopMailService,
    SmtpMailService,
    {
      provide: MAIL,
      useExisting: SmtpMailService,
    },
  ],
  exports: [MAIL, SmtpMailService, NoopMailService],
})
export class MailModule {}
