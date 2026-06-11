import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import { renderPasswordResetEmail } from "@slugbase/email-templates";
import type { MailService } from "@slugbase/shared-types";

import { AccountsService } from "../../accounts/accounts.service.js";
import { ConfigService } from "../../config/config.service.js";
import { DbService } from "../../db/db.service.js";
import { MAIL } from "../../mail/mail.tokens.js";
import { SessionService } from "../../sessions/session.service.js";
import { PasswordResetTokenRepository } from "./password-reset-token.repository.js";

/** 1-hour expiry for reset tokens (spec §5.5, defaults-and-constants.md §3). */
const TOKEN_TTL_MS = 60 * 60 * 1000;
/** Token is 32 random bytes rendered as hex (64-char string). */
const TOKEN_BYTES = 32;

/**
 * Computes the SHA-256 hex digest of a plaintext reset token.
 * Only the hash is stored; the plaintext is delivered to the user via email.
 */
export function hashResetToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generates a cryptographically random plaintext reset token.
 */
export function generateResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Builds the password-reset link for the reset-password UI.
 *
 * Hosted (API + separate web Worker): use FRONTEND_ORIGIN (spec §14.7).
 * Self-hosted combined image (SERVE_WEB_CLIENT): use APP_BASE_URL as the single public origin.
 */
export function buildPasswordResetUrl(params: {
  appBaseUrl: string;
  frontendOrigin: string;
  serveWebClient: boolean;
  token: string;
}): string {
  const origin = params.serveWebClient ? params.appBaseUrl : params.frontendOrigin;
  const url = new URL("/reset-password", origin);
  url.searchParams.set("token", params.token);
  return url.href;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly tokenRepo: PasswordResetTokenRepository;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MAIL) private readonly mail: MailService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {
    this.tokenRepo = new PasswordResetTokenRepository(db.getOrm());
  }

  /**
   * Initiates the password reset flow for the given email address.
   *
   * NON-ENUMERATING (spec §5.4): always resolves without error regardless of
   * whether the email is registered. The caller must return the same 200
   * response to the client in both cases.
   */
  async forgotPassword(email: string): Promise<void> {
    const account = await this.accounts.findByEmail(email);

    if (!account) {
      this.logger.debug("Password reset requested for unknown email - no-op");
      return;
    }

    const plaintext = generateResetToken();
    const tokenHash = hashResetToken(plaintext);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await this.tokenRepo.create(account.id, tokenHash, expiresAt);

    const resetUrl = buildPasswordResetUrl({
      appBaseUrl: this.config.get("APP_BASE_URL"),
      frontendOrigin: this.config.get("FRONTEND_ORIGIN"),
      serveWebClient: this.config.get("SERVE_WEB_CLIENT"),
      token: plaintext,
    });

    if (this.mail.isAvailable()) {
      await this.mail.send({
        to: email,
        subject: "Reset your SlugBase password",
        text: [
          "You requested a password reset for your SlugBase account.",
          "",
          "Click the link below to set a new password:",
          resetUrl,
          "",
          "This link expires in 1 hour.",
          "",
          "If you did not request a password reset, you can safely ignore this email.",
          "Your password will not be changed.",
        ].join("\n"),
        html: renderPasswordResetEmail({ resetUrl }),
        type: "password_reset",
      });
    } else {
      this.logger.warn(
        "Mail transport unavailable - password reset token created but email not sent",
        { userId: account.id },
      );
    }
  }

  /**
   * Validates the reset token and updates the user's password.
   *
   * On success:
   * - marks the token as used
   * - updates the password hash (argon2id)
   * - revokes ALL existing sessions for the user
   *
   * On failure: throws UnprocessableEntityException with a generic message.
   */
  async resetPassword(plaintext: string, newPassword: string): Promise<void> {
    const tokenHash = hashResetToken(plaintext);
    const record = await this.tokenRepo.findByTokenHash(tokenHash);

    if (!record) {
      throw new UnprocessableEntityException(
        "Password reset link is invalid or has already been used",
      );
    }

    if (record.usedAt !== null) {
      throw new UnprocessableEntityException(
        "Password reset link is invalid or has already been used",
      );
    }

    if (record.expiresAt <= new Date()) {
      throw new UnprocessableEntityException(
        "Password reset link has expired - please request a new one",
      );
    }

    await this.tokenRepo.markUsed(record.id, Date.now());
    await this.accounts.updatePassword(record.userId, newPassword);
    await this.sessions.revokeAllSessions(record.userId);
  }
}
