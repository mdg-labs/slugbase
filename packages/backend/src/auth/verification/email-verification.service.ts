import { createHash, randomBytes } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { renderSignupVerificationEmail } from "@slugbase/email-templates";
import type { MailService } from "@slugbase/shared-types";

import { AccountsService } from "../../accounts/accounts.service.js";
import { ConfigService } from "../../config/config.service.js";
import { DbService } from "../../db/db.service.js";
import { MAIL } from "../../mail/mail.tokens.js";
import { EmailVerificationTokenRepository } from "./email-verification-token.repository.js";
import {
  assertVerificationEmailRateLimit,
  verificationEmailRateLimitSinceMs,
} from "./verification-email-rate-limit.js";

/** 24-hour expiry for verification tokens (spec §5.5, SB-17 task spec). */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
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

/**
 * Builds the signup verification link for the verify-email UI.
 *
 * Hosted (API + separate web Worker): use FRONTEND_ORIGIN (spec §14.7).
 * Self-hosted combined image (SERVE_WEB_CLIENT): use APP_BASE_URL as the single public origin.
 */
export function buildEmailVerificationUrl(params: {
  appBaseUrl: string;
  frontendOrigin: string;
  serveWebClient: boolean;
  token: string;
}): string {
  const origin = params.serveWebClient ? params.appBaseUrl : params.frontendOrigin;
  const url = new URL("/verify-email", origin);
  url.searchParams.set("token", params.token);
  return url.href;
}

/** Masks an email address for safe display in the verify-email UI. */
export function maskEmailForDisplay(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return "***@***.***";
  }

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visibleLocal = local.length <= 1 ? "*" : `${local.slice(0, 1)}***`;

  const dotIndex = domain.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${visibleLocal}@***`;
  }

  const domainName = domain.slice(0, dotIndex);
  const tld = domain.slice(dotIndex + 1);
  const visibleDomain = domainName.length <= 1 ? "*" : `${domainName.slice(0, 1)}***`;
  return `${visibleLocal}@${visibleDomain}.${tld}`;
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

    const verifyUrl = buildEmailVerificationUrl({
      appBaseUrl: this.config.get("APP_BASE_URL"),
      frontendOrigin: this.config.get("FRONTEND_ORIGIN"),
      serveWebClient: this.config.get("SERVE_WEB_CLIENT"),
      token: plaintext,
    });

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
        html: renderSignupVerificationEmail({ verifyUrl }),
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
   * Rate-limited resend of the verification email (RATE_LIMIT_EMAIL_VERIFICATION_*).
   */
  async resendVerification(userId: string): Promise<void> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (account.emailVerified) {
      throw new UnprocessableEntityException("Email address is already verified");
    }

    const sinceMs = verificationEmailRateLimitSinceMs(this.config);
    const recentCount = await this.tokenRepo.countRecentByUserId(userId, sinceMs);
    assertVerificationEmailRateLimit(recentCount, this.config);

    await this.issueToken(userId, account.email);
  }

  /**
   * Updates the signup email for an unverified account, invalidates outstanding
   * verification tokens, and sends a fresh verification link to the new address.
   * Verified accounts must use the change-email flow instead.
   */
  async correctSignupEmail(
    userId: string,
    newEmail: string,
  ): Promise<{ maskedEmail: string }> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (account.emailVerified) {
      throw new ForbiddenException(
        "Email address is already verified — use account settings to change your email",
      );
    }

    const normalizedEmail = newEmail.trim();
    if (normalizedEmail.toLowerCase() === account.email.toLowerCase()) {
      return { maskedEmail: maskEmailForDisplay(account.email) };
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
    await this.accounts.updateEmail(userId, normalizedEmail);
    await this.issueToken(userId, normalizedEmail);

    return { maskedEmail: maskEmailForDisplay(normalizedEmail) };
  }
}
