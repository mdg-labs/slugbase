import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { AccountsService } from "../accounts/accounts.service.js";
import { PasswordService } from "../accounts/password.service.js";
import { ConfigService } from "../config/config.service.js";
import { SessionService } from "../sessions/session.service.js";
import { SkipCsrf } from "./csrf/skip-csrf.decorator.js";
import { MfaService } from "./mfa/mfa.service.js";

export const SESSION_COOKIE = "slb_session";

interface LoginBody {
  email: string;
  password: string;
}

type LoginResult =
  | { userId: string; mfaRequired?: never }
  | { mfaRequired: true; userId?: never };

@Controller("auth")
@SkipCsrf()
export class LoginLogoutController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MfaService) private readonly mfa: MfaService,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const { email, password } = body;

    const account = await this.accounts.findByEmail(email);
    if (!account) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const valid = await this.passwords.verifyPassword(
      account.passwordHash,
      password,
    );
    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }

    if (account.mfaState === "enrolled") {
      const { cookieValue } = await this.sessions.createSession({
        userId: account.id,
        data: { mfaPending: true },
      });

      res.cookie(SESSION_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: this.config.get("isProduction"),
      });

      return { mfaRequired: true };
    }

    const sessionData: Record<string, unknown> = {};
    if (!account.emailVerified) {
      sessionData["emailVerificationPending"] = true;
    }

    const { cookieValue } = await this.sessions.createSession({
      userId: account.id,
      data: sessionData,
    });

    res.cookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.get("isProduction"),
    });

    return { userId: account.id };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const rawCookie = req.cookies[SESSION_COOKIE] as string | undefined;

    if (rawCookie) {
      const sessionId = this.sessions.verifySessionCookie(rawCookie);
      if (sessionId) {
        await this.sessions.revokeSession(sessionId);
      }
    }

    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }
}
