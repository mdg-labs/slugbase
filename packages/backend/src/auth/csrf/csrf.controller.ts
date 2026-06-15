import { Controller, Get, Inject, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";

import { ConfigService } from "../../config/config.service.js";
import { CsrfService } from "./csrf.service.js";
import { SkipCsrf } from "./skip-csrf.decorator.js";

const CSRF_COOKIE = "csrf_token";

/**
 * Double-submit CSRF (spec §5.8, SEC-025): the token cookie is intentionally
 * readable by JavaScript so the SPA can mirror it in X-CSRF-Token. The session
 * cookie remains HttpOnly. CSP hardening is tracked in #428.
 */
@Controller("auth")
@SkipCsrf()
@SkipThrottle({ ip: true, "user-hour": true })
export class CsrfController {
  constructor(
    @Inject(CsrfService) private readonly csrfService: CsrfService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Get("csrf-token")
  getCsrfToken(@Res({ passthrough: true }) res: Response): {
    csrfToken: string;
  } {
    const token = this.csrfService.generateToken();
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      secure: this.config.cookieSecure(),
    });
    return { csrfToken: token };
  }
}
