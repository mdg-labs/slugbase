import { Injectable, Logger } from "@nestjs/common";
import type { MailMessage, MailService } from "@slugbase/shared-types";

/**
 * No-op mail implementation - used when SMTP_HOST is not configured.
 * Logs a warning for every attempted send so operators know email is degraded.
 * Reports itself as unavailable so callers can surface appropriate messaging.
 */
@Injectable()
export class NoopMailService implements MailService {
  private readonly logger = new Logger(NoopMailService.name);

  send(message: MailMessage): Promise<void> {
    this.logger.warn("Mail transport not configured - dropping message", {
      type: message.type,
      to: message.to,
    });
    return Promise.resolve();
  }

  isAvailable(): boolean {
    return false;
  }

  ensureAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  sendTest(to: string): Promise<void> {
    this.logger.warn("Mail transport not configured - test send skipped", {
      to,
    });
    return Promise.resolve();
  }
}
