import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { CryptoModule } from "../crypto/crypto.module.js";
import { DbModule } from "../db/db.module.js";
import { MailRuntimeService } from "./mail-runtime.service.js";
import { NoopMailService } from "./noop-mail.service.js";
import { MAIL, MAIL_TRANSPORT_HYDRATOR } from "./mail.tokens.js";
import { SmtpMailService } from "./smtp-mail.service.js";

/**
 * Provides the MAIL interface token bound to {@link SmtpMailService}.
 * Env `SMTP_*` vars configure the transport at construction; DB-backed workspace
 * settings apply via {@link MailRuntimeService} on startup and lazily on first
 * send/availability check (spec §11.1, §15). Unconfigured transport reports
 * unavailable and degrades gracefully on send.
 */
@Global()
@Module({
  imports: [ConfigModule, CryptoModule, DbModule],
  providers: [
    NoopMailService,
    SmtpMailService,
    MailRuntimeService,
    {
      provide: MAIL,
      useExisting: SmtpMailService,
    },
    {
      provide: MAIL_TRANSPORT_HYDRATOR,
      useExisting: MailRuntimeService,
    },
  ],
  exports: [MAIL, SmtpMailService, NoopMailService, MailRuntimeService],
})
export class MailModule {}
