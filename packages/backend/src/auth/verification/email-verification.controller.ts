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
import { CorrectSignupEmailBodySchema } from "@slugbase/shared-types";

import { SessionService } from "../../sessions/session.service.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { EmailVerificationService } from "./email-verification.service.js";

@Controller("auth")
@SkipCsrf()
export class EmailVerificationController {
  constructor(
    @Inject(EmailVerificationService)
    private readonly verificationService: EmailVerificationService,
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
  ): Promise<{ ok: true; userId: string }> {
    if (!token) {
      throw new UnauthorizedException("Verification token is required");
    }

    const result = await this.verificationService.verifyToken(token);
    return { ok: true, userId: result.userId };
  }

  /**
   * Resends the verification email for the currently authenticated user.
   * Rate-limited to MAX_RESENDS_PER_HOUR (3) per hour per user.
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
    const parsed = CorrectSignupEmailBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Unable to update email address");
    }

    return this.verificationService.correctSignupEmail(
      session.userId,
      parsed.data.email,
    );
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
