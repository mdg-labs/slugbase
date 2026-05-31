import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";

import { ConfigService } from "../../config/config.service.js";
import { CsrfService } from "./csrf.service.js";
import { SkipCsrf } from "./skip-csrf.decorator.js";

const CSRF_COOKIE = "csrf_token";

@Controller("auth")
@SkipCsrf()
export class CsrfController {
  constructor(
    @Inject(CsrfService) private readonly csrfService: CsrfService,
    private readonly config: ConfigService,
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
      secure: this.config.get("isProduction"),
    });
    return { csrfToken: token };
  }
}
