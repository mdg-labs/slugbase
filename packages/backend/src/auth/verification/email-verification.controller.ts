import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { SessionService } from "../../sessions/session.service.js";
import type { SessionData } from "../../sessions/session.types.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { EmailChangeService } from "../account/email-change.service.js";
import { EmailVerificationService } from "./email-verification.service.js";

const correctSignupEmailBodySchema = z
  .object({
    email: z.string().trim().email(),
  })
  .strict();

@Controller("auth")
@SkipCsrf()
export class EmailVerificationController {
  constructor(
    @Inject(EmailVerificationService)
    private readonly verificationService: EmailVerificationService,
    @Inject(EmailChangeService) private readonly emailChangeService: EmailChangeService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * Verifies an email address via a plaintext token delivered to the user's inbox.
   * Non-enumerating: always returns the same generic error on any token failure.
   * @SkipCsrf — GET request from email link; no state-mutating side-effects beyond
   * marking the token consumed and setting email_verified=true.
   */
  @Get("verify-email")
  @HttpCode(200)
  async verifyEmail(
    @Query("token") token: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: true; userId: string }> {
    if (!token) {
      throw new UnauthorizedException("Verification token is required");
    }

    const result = await this.verificationService.verifyToken(token);
    await this.clearEmailVerificationPendingForSession(req, result.userId);
    return { ok: true, userId: result.userId };
  }

  @Get("verify-email-change")
  @HttpCode(200)
  async verifyEmailChange(
    @Query("token") token: string | undefined,
  ): Promise<{ ok: true; email: string }> {
    if (!token) {
      throw new UnauthorizedException("Verification token is required");
    }

    const result = await this.emailChangeService.verifyToken(token);
    return { ok: true, email: result.email };
  }

  /**
   * Resends the verification email for the currently authenticated user.
   * Rate-limited via RATE_LIMIT_EMAIL_VERIFICATION_MAX / _TTL_SECONDS per user.
   * Requires a full session (not mfaPending).
   */
  @Post("resend-verification")
  @HttpCode(200)
  async resendVerification(@Req() req: Request): Promise<{ ok: true }> {
    const session = await this.requireFullSession(req);
    await this.verificationService.resendVerification(session.userId);
    return { ok: true };
  }

  /**
   * Corrects a signup typo before first verification. Only available when
   * emailVerified=false; verified accounts must use the change-email flow.
   */
  @Post("correct-signup-email")
  @HttpCode(200)
  async correctSignupEmail(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ maskedEmail: string }> {
    const session = await this.requireFullSession(req);
    const parsed = correctSignupEmailBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Unable to update email address");
    }

    return this.verificationService.correctSignupEmail(
      session.userId,
      parsed.data.email,
    );
  }

  private async clearEmailVerificationPendingForSession(
    req: Request,
    userId: string,
  ): Promise<void> {
    const rawCookie = req.cookies[SESSION_COOKIE] as string | undefined;
    if (!rawCookie) return;

    const sessionId = this.sessions.verifySessionCookie(rawCookie);
    if (!sessionId) return;

    const session = await this.sessions.findSession(sessionId);
    if (!session || session.userId !== userId) return;

    const data = session.data as SessionData;
    if (data.emailVerificationPending !== true) return;

    const { emailVerificationPending: _removed, ...rest } = data;
    await this.sessions.updateSessionData(sessionId, rest);
  }

  private async requireFullSession(req: Request) {
    const rawCookie = req.cookies[SESSION_COOKIE] as string | undefined;
    if (!rawCookie) throw new UnauthorizedException();

    const sessionId = this.sessions.verifySessionCookie(rawCookie);
    if (!sessionId) throw new UnauthorizedException();

    const session = await this.sessions.findSession(sessionId);
    if (!session) throw new UnauthorizedException();

    if (session.data["mfaPending"] === true) {
      throw new ForbiddenException(
        "MFA challenge must be completed before proceeding",
      );
    }

    return session;
  }
}
