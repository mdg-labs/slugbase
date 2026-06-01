import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { SESSION_COOKIE } from "../sessions/session-constants.js";
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  AnalyticsConsentService,
} from "./analytics-consent.service.js";

interface ConsentBody {
  granted: boolean;
}

interface ConsentStatusResponse {
  enabled: boolean;
  decided: boolean;
  granted: boolean | null;
}

interface SaveConsentResponse {
  granted: boolean;
}

interface AnalyticsPublicConfigResponse {
  enabled: boolean;
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly consentService: AnalyticsConsentService) {}

  @Get("config")
  getConfig(): AnalyticsPublicConfigResponse {
    return this.consentService.getPublicConfig();
  }

  @Get("consent")
  async getConsent(@Req() req: Request): Promise<ConsentStatusResponse> {
    const clientId = this.consentService.resolveClientId(
      req.cookies[ANALYTICS_CONSENT_COOKIE] as string | undefined,
    );
    const userId = await this.consentService.resolveOptionalUserId(
      req.cookies[SESSION_COOKIE] as string | undefined,
    );
    const status = await this.consentService.getConsentStatus(clientId, userId);

    return {
      enabled: this.consentService.getPublicConfig().enabled,
      decided: status.decided,
      granted: status.granted,
    };
  }

  @Post("consent")
  async saveConsent(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: ConsentBody,
  ): Promise<SaveConsentResponse> {
    const clientId = this.consentService.resolveClientId(
      req.cookies[ANALYTICS_CONSENT_COOKIE] as string | undefined,
    );
    const userId = await this.consentService.resolveOptionalUserId(
      req.cookies[SESSION_COOKIE] as string | undefined,
    );

    res.cookie(ANALYTICS_CONSENT_COOKIE, clientId, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.consentService.isProduction(),
      maxAge: ANALYTICS_CONSENT_MAX_AGE_SECONDS * 1000,
      path: "/",
    });

    const status = await this.consentService.saveConsent(
      clientId,
      body.granted,
      userId,
    );

    return { granted: status.granted ?? false };
  }
}
