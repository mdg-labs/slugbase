import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";

import { ConfigService } from "../../config/config.service.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { IpThrottlerGuard } from "../rate-limit/ip-throttler.guard.js";
import { RegistrationService, type RegisterDto } from "./registration.service.js";

interface RegisterResponse {
  userId: string;
  emailVerificationRequired?: boolean;
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
  @UseGuards(IpThrottlerGuard)
  @SkipThrottle({ "user-hour": true })
  async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterResponse> {
    const { userId, cookieValue, emailVerificationRequired } =
      await this.registrationService.register(body);

    res.cookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.get("isProduction"),
    });

    if (emailVerificationRequired) {
      return { userId, emailVerificationRequired: true };
    }

    return { userId };
  }
}
