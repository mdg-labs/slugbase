import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";

import { SmtpMailService } from "../mail/smtp-mail.service.js";
import { MailSettingsService } from "./mail-settings.service.js";

/**
 * Loads persisted SMTP settings into {@link SmtpMailService} at application startup
 * so self-hosted installs work without `SMTP_*` env vars (spec §11.1, §15).
 */
@Injectable()
export class MailTransportBootstrapService implements OnModuleInit {
  constructor(
    @Inject(MailSettingsService) private readonly mailSettings: MailSettingsService,
    @Inject(SmtpMailService) private readonly smtpMail: SmtpMailService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.mailSettings.applyToTransport(this.smtpMail);
  }
}
