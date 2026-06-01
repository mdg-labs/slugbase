import { createHash, randomBytes } from "node:crypto";

import {
  HttpException,
  HttpStatus,
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
import { EmailVerificationTokenRepository } from "./email-verification-token.repository.js";

/** 24-hour expiry for verification tokens (spec §5.5, SB-17 task spec). */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Rate limit: max 3 resend requests per hour per user. */
const MAX_RESENDS_PER_HOUR = 3;
const ONE_HOUR_MS = 60 * 60 * 1000;
/** Token is 32 random bytes rendered as hex (64-char string). */
const TOKEN_BYTES = 32;

/**
 * Computes the SHA-256 hex digest of a plaintext token.
 * Only the hash is stored; the plaintext is sent to the user via email.
 */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generates a cryptographically random plaintext verification token.
 */
export function generateVerificationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly tokenRepo: EmailVerificationTokenRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MAIL) private readonly mail: MailService,
  ) {
    this.tokenRepo = new EmailVerificationTokenRepository(db.getOrm());
  }

  /**
   * Issues a verification token for the given user and sends the verification
   * email. Safe to call on registration (no rate-limit check) and on explicit
   * resend (rate-limited via {@link resendVerification}).
   *
   * If the mail transport is unavailable, the token is still created in the DB
   * so the flow can succeed once mail is configured.
   */
  async issueToken(userId: string, email: string): Promise<void> {
    const plaintext = generateVerificationToken();
    const tokenHash = hashToken(plaintext);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await this.tokenRepo.create(userId, tokenHash, expiresAt);

    const baseUrl = this.config.get("APP_BASE_URL");
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${plaintext}`;

    if (this.mail.isAvailable()) {
      await this.mail.send({
        to: email,
        subject: "Verify your SlugBase email address",
        text: [
          "Welcome to SlugBase!",
          "",
          "Please verify your email address by clicking the link below:",
          verifyUrl,
          "",
          "This link expires in 24 hours.",
          "",
          "If you did not create an account, you can safely ignore this email.",
        ].join("\n"),
        type: "signup_verification",
      });
    } else {
      this.logger.warn(
        "Mail transport unavailable — verification token created but email not sent",
        { userId },
      );
    }
  }

  /**
   * Verifies a plaintext token received from the user.
   * On success: marks the account email_verified=true and invalidates the token.
   * On failure: throws with a generic error message (non-enumerating, spec §5).
   */
  async verifyToken(plaintext: string): Promise<{ userId: string }> {
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

    await this.tokenRepo.markUsed(record.id, Date.now());
    await this.accounts.markEmailVerified(record.userId);

    return { userId: record.userId };
  }

  /**
   * Rate-limited resend of the verification email.
   * Throws {@link TooManyRequestsException} if the user has already triggered
   * more than {@link MAX_RESENDS_PER_HOUR} sends in the last hour.
   */
  async resendVerification(userId: string): Promise<void> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (account.emailVerified) {
      throw new UnprocessableEntityException("Email address is already verified");
    }

    const sinceMs = Date.now() - ONE_HOUR_MS;
    const recentCount = await this.tokenRepo.countRecentByUserId(userId, sinceMs);

    if (recentCount >= MAX_RESENDS_PER_HOUR) {
      throw new HttpException(
        "Too many verification emails requested — please wait before trying again",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.issueToken(userId, account.email);
  }
}
