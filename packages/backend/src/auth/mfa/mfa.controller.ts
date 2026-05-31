import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { AccountsService } from "../../accounts/accounts.service.js";
import { SessionService } from "../../sessions/session.service.js";
import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { MfaService } from "./mfa.service.js";

interface EnrolStartBody {
  // no body needed; user is identified via session
  _placeholder?: never;
}

interface EnrolConfirmBody {
  totpCode: string;
}

interface ChallengeBody {
  code: string;
}

interface DisableBody {
  totpCode: string;
}

interface RegenerateBody {
  totpCode: string;
}

@Controller("auth/mfa")
@SkipCsrf()
export class MfaController {
  constructor(
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * Start MFA enrollment. Requires a fully authenticated session (not mfaPending).
   * Returns QR data URI + text secret for display.
   */
  @Post("enrol/start")
  @HttpCode(200)
  async enrolStart(
    @Req() req: Request,
    @Body() _body: EnrolStartBody,
  ): Promise<{ otpAuthUri: string; textSecret: string; qrDataUri: string }> {
    const session = await this.requireFullSession(req);
    const account = await this.accounts.findById(session.userId);
    if (!account) throw new UnauthorizedException();
    if (account.mfaState === "enrolled") {
      throw new BadRequestException("MFA is already enrolled");
    }

    const result = await this.mfa.enrolStart(session.userId, account.email);
    return {
      otpAuthUri: result.otpAuthUri,
      textSecret: result.textSecret,
      qrDataUri: result.qrDataUri,
    };
  }

  /**
   * Confirm MFA enrollment by submitting the first TOTP code.
   * Returns the 10 backup codes (shown ONCE).
   */
  @Post("enrol/confirm")
  @HttpCode(200)
  async enrolConfirm(
    @Req() req: Request,
    @Body() body: EnrolConfirmBody,
  ): Promise<{ backupCodes: string[] }> {
    if (!body.totpCode) throw new BadRequestException("totpCode is required");

    const session = await this.requireFullSession(req);
    const result = await this.mfa.enrolConfirm(session.userId, body.totpCode);
    return { backupCodes: result.backupCodes };
  }

  /**
   * Complete a pending MFA challenge during login.
   * Requires a pending-MFA session (data.mfaPending === true).
   * Accepts either a TOTP code or a backup code.
   */
  @Post("challenge")
  @HttpCode(200)
  async challenge(
    @Req() req: Request,
    @Body() body: ChallengeBody,
  ): Promise<{ userId: string }> {
    if (!body.code) throw new BadRequestException("code is required");

    const rawCookie = req.cookies[SESSION_COOKIE] as string | undefined;
    if (!rawCookie) throw new UnauthorizedException();

    const sessionId = this.sessions.verifySessionCookie(rawCookie);
    if (!sessionId) throw new UnauthorizedException();

    const session = await this.sessions.findSession(sessionId);
    if (!session) throw new UnauthorizedException();

    if (session.data["mfaPending"] !== true) {
      throw new ForbiddenException("Session is not in MFA-pending state");
    }

    const valid = await this.mfa.verifyChallengeCode(session.userId, body.code);
    if (!valid) throw new UnauthorizedException("Invalid MFA code");

    const { mfaPending: _removed, ...rest } = session.data as Record<string, unknown> & { mfaPending?: boolean };
    await this.sessions.updateSessionData(sessionId, rest);

    return { userId: session.userId };
  }

  /**
   * Disable MFA. Requires a fully authenticated session and a valid TOTP code.
   */
  @Post("disable")
  @HttpCode(200)
  async disable(
    @Req() req: Request,
    @Body() body: DisableBody,
  ): Promise<{ ok: true }> {
    if (!body.totpCode) throw new BadRequestException("totpCode is required");
    const session = await this.requireFullSession(req);
    await this.mfa.disable(session.userId, body.totpCode);
    return { ok: true };
  }

  /**
   * Regenerate backup codes. Requires a fully authenticated session and valid TOTP.
   * Returns 10 new backup codes (shown ONCE).
   */
  @Post("backup-codes/regenerate")
  @HttpCode(200)
  async regenerateBackupCodes(
    @Req() req: Request,
    @Body() body: RegenerateBody,
  ): Promise<{ backupCodes: string[] }> {
    if (!body.totpCode) throw new BadRequestException("totpCode is required");
    const session = await this.requireFullSession(req);
    const codes = await this.mfa.regenerateBackupCodes(session.userId, body.totpCode);
    return { backupCodes: codes };
  }

  /** Resolves the session from the cookie and ensures it is fully authenticated (not mfaPending). */
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
