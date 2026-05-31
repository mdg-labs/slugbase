import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

import { ConfigService } from "../../config/config.service.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { RegistrationService, type RegisterDto } from "./registration.service.js";

interface RegisterResponse {
  userId: string;
}

@Controller("auth")
@SkipCsrf()
export class RegistrationController {
  constructor(
    @Inject(RegistrationService)
    private readonly registrationService: RegistrationService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Post("register")
  @HttpCode(201)
  async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterResponse> {
    const { userId, cookieValue } = await this.registrationService.register(body);

    res.cookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.get("isProduction"),
    });

    return { userId };
  }
}
