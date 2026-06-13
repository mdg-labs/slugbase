import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

import { ConfigService } from "../config/config.service.js";
import { SkipCsrf } from "../auth/csrf/skip-csrf.decorator.js";
import { SESSION_COOKIE } from "../auth/login-logout.controller.js";
import { SetupService, type CompleteSetupDto, type SetupStatusResult } from "./setup.service.js";

interface CompleteSetupResponse {
  userId: string;
}

@Controller("setup")
@SkipCsrf()
export class SetupController {
  constructor(
    @Inject(SetupService) private readonly setupService: SetupService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Get("status")
  async getStatus(): Promise<SetupStatusResult> {
    return this.setupService.getStatus();
  }

  @Post("complete")
  @HttpCode(201)
  async completeSetup(
    @Body() body: CompleteSetupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompleteSetupResponse> {
    const { userId, cookieValue } = await this.setupService.completeSetup(body);

    res.cookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.cookieSecure(),
    });

    return { userId };
  }
}
