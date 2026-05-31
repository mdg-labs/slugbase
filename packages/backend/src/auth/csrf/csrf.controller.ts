import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";

import type { AppConfig } from "../../config/env.schema.js";
import { CsrfService } from "./csrf.service.js";
import { SkipCsrf } from "./skip-csrf.decorator.js";

const CSRF_COOKIE = "csrf_token";

@Controller("auth")
@SkipCsrf()
export class CsrfController {
  constructor(
    @Inject(CsrfService) private readonly csrfService: CsrfService,
    private readonly config: ConfigService<AppConfig>,
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
      secure: this.config.get("isProduction") ?? false,
    });
    return { csrfToken: token };
  }
}
