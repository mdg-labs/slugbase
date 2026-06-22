import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { NoopMailService } from "./noop-mail.service.js";
import { MAIL } from "./mail.tokens.js";
import { SmtpMailService } from "./smtp-mail.service.js";

/**
 * Provides the MAIL interface token bound to {@link SmtpMailService}.
 * `SMTP_*` env vars configure the transport at construction. Unconfigured
 * transport reports unavailable and degrades gracefully on send (spec §11.1, §15).
 */
@Global()
@Module({
  imports: [ConfigModule],
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
