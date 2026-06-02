import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { MailService } from "@slugbase/shared-types";

import { AccountsService } from "../../accounts/accounts.service.js";
import { ConfigService } from "../../config/config.service.js";
import { DbService } from "../../db/db.service.js";
import { MAIL } from "../../mail/mail.tokens.js";
import {
  generateVerificationToken,
  hashToken,
  maskEmailForDisplay,
} from "../verification/email-verification.service.js";
import {
  assertVerificationEmailRateLimit,
  verificationEmailRateLimitSinceMs,
} from "../verification/verification-email-rate-limit.js";
import { EmailChangeTokenRepository } from "./email-change-token.repository.js";

/** 24-hour expiry for email-change tokens (spec §5.5). */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function buildEmailChangeVerificationUrl(params: {
  appBaseUrl: string;
  frontendOrigin: string;
  serveWebClient: boolean;
  token: string;
}): string {
  const origin = params.serveWebClient ? params.appBaseUrl : params.frontendOrigin;
  const url = new URL("/verify-email-change", origin);
  url.searchParams.set("token", params.token);
  return url.href;
}

@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);
  private readonly tokenRepo: EmailChangeTokenRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MAIL) private readonly mail: MailService,
  ) {
    this.tokenRepo = new EmailChangeTokenRepository(db.getOrm());
  }

  async requestChange(userId: string, newEmail: string): Promise<{ pendingEmail: string }> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    const normalizedEmail = newEmail.trim();
    if (normalizedEmail.toLowerCase() === account.email.toLowerCase()) {
      throw new BadRequestException("New email must differ from your current address");
    }

    const existing = await this.accounts.findByEmail(normalizedEmail);
    if (existing && existing.id !== userId) {
      throw new ConflictException("An account with this email already exists");
    }

    const sinceMs = verificationEmailRateLimitSinceMs(this.config);
    const recentCount = await this.tokenRepo.countRecentByUserId(userId, sinceMs);
    assertVerificationEmailRateLimit(recentCount, this.config);

    const nowMs = Date.now();
    await this.tokenRepo.invalidateUnusedByUserId(userId, nowMs);
    await this.accounts.setPendingEmail(userId, normalizedEmail);
    await this.issueToken(userId, normalizedEmail);

    return { pendingEmail: normalizedEmail };
  }

  async resendPending(userId: string): Promise<void> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (!account.pendingEmail) {
      throw new UnprocessableEntityException("No pending email change to resend");
    }

    const sinceMs = verificationEmailRateLimitSinceMs(this.config);
    const recentCount = await this.tokenRepo.countRecentByUserId(userId, sinceMs);
    assertVerificationEmailRateLimit(recentCount, this.config);

    await this.issueToken(userId, account.pendingEmail);
  }

  async cancelPending(userId: string): Promise<void> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (!account.pendingEmail) {
      return;
    }

    await this.tokenRepo.invalidateUnusedByUserId(userId, Date.now());
    await this.accounts.setPendingEmail(userId, null);
  }

  async verifyToken(plaintext: string): Promise<{ userId: string; email: string }> {
    const tokenHash = hashToken(plaintext);
    const record = await this.tokenRepo.findByTokenHash(tokenHash);

    if (!record) {
      throw new NotFoundException("Verification link is invalid or has already been used");
    }

    if (record.usedAt !== null) {
      throw new UnprocessableEntityException(
        "Verification link is invalid or has already been used",
      );
    }

    if (record.expiresAt <= new Date()) {
      throw new UnprocessableEntityException(
        "Verification link has expired — please request a new one",
      );
    }

    const existing = await this.accounts.findByEmail(record.pendingEmail);
    if (existing && existing.id !== record.userId) {
      throw new ConflictException("An account with this email already exists");
    }

    await this.tokenRepo.markUsed(record.id, Date.now());
    await this.accounts.updateEmail(record.userId, record.pendingEmail);
    await this.accounts.setPendingEmail(record.userId, null);
    await this.accounts.markEmailVerified(record.userId);

    return { userId: record.userId, email: record.pendingEmail };
  }

  maskPendingEmail(email: string | null): string | null {
    return email ? maskEmailForDisplay(email) : null;
  }

  private async issueToken(userId: string, pendingEmail: string): Promise<void> {
    const plaintext = generateVerificationToken();
    const tokenHash = hashToken(plaintext);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await this.tokenRepo.create(userId, pendingEmail, tokenHash, expiresAt);

    const verifyUrl = buildEmailChangeVerificationUrl({
      appBaseUrl: this.config.get("APP_BASE_URL"),
      frontendOrigin: this.config.get("FRONTEND_ORIGIN"),
      serveWebClient: this.config.get("SERVE_WEB_CLIENT"),
      token: plaintext,
    });

    if (this.mail.isAvailable()) {
      await this.mail.send({
        to: pendingEmail,
        subject: "Confirm your new SlugBase email address",
        text: [
          "You requested to change the email address on your SlugBase account.",
          "",
          "Confirm your new address by clicking the link below:",
          verifyUrl,
          "",
          "This link expires in 24 hours.",
          "",
          "If you did not request this change, you can ignore this email.",
        ].join("\n"),
        type: "email_change_verification",
      });
    } else {
      this.logger.warn(
        "Mail transport unavailable — email change token created but email not sent",
        { userId },
      );
    }
  }
}
