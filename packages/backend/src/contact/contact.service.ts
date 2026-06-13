import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { renderContactFormNotificationEmail } from "@slugbase/email-templates";
import type { MailService } from "@slugbase/shared-types";
import { ZodError } from "zod";

import { ConfigService } from "../config/config.service.js";
import {
  ChallengeVerificationError,
  type ChallengeService,
} from "../challenge/challenge.interface.js";
import { CHALLENGE } from "../challenge/challenge.tokens.js";
import { MAIL } from "../mail/mail.tokens.js";
import { CONTACT_TOPIC_LABELS } from "./contact.constants.js";
import {
  parseContactSubmitBody,
  type ContactSubmitBody,
} from "./contact.validation.js";

@Injectable()
export class ContactService {
  constructor(
    @Inject(CHALLENGE) private readonly challenge: ChallengeService,
    @Inject(MAIL) private readonly mail: MailService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async submit(body: unknown, remoteIp?: string): Promise<void> {
    let dto: ContactSubmitBody;
    try {
      dto = parseContactSubmitBody(body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException("Invalid contact submission");
      }
      throw error;
    }

    try {
      await this.challenge.verify({
        token: dto.challengeToken,
        remoteIp,
      });
    } catch (error) {
      if (error instanceof ChallengeVerificationError) {
        throw new BadRequestException("Challenge verification failed");
      }
      throw error;
    }

    if (!this.mail.isAvailable()) {
      throw new ServiceUnavailableException(
        "Contact form is temporarily unavailable",
      );
    }

    const recipient = this.getNotificationRecipient();
    const topicLabel = CONTACT_TOPIC_LABELS[dto.topic];

    await this.mail.send({
      to: recipient,
      subject: `[SlugBase Contact] ${topicLabel}`,
      text: [
        `Name: ${dto.name}`,
        `Email: ${dto.email}`,
        `Topic: ${topicLabel}`,
        "",
        dto.message,
      ].join("\n"),
      html: renderContactFormNotificationEmail({
        name: dto.name,
        email: dto.email,
        topic: topicLabel,
        message: dto.message,
      }),
      type: "contact_form_notification",
    });
  }

  /** Operator inbox - defaults to SMTP_FROM when no dedicated inbox is configured. */
  private getNotificationRecipient(): string {
    const smtpFrom = this.config.get("SMTP_FROM");
    if (smtpFrom?.trim()) {
      return smtpFrom.trim();
    }
    throw new ServiceUnavailableException(
      "Contact form is temporarily unavailable",
    );
  }
}
