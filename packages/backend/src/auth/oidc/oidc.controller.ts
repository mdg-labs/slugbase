import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";

import type { CryptoService } from "@slugbase/shared-types";

import { ConfigService } from "../../config/config.service.js";
import { CRYPTO } from "../../crypto/crypto.tokens.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { SkipCsrf } from "../csrf/skip-csrf.decorator.js";
import { SessionService } from "../../sessions/session.service.js";
import { OidcService } from "./oidc.service.js";
import type { OidcFlowState } from "./oidc.types.js";

/**
 * Short-lived cookie holding the encrypted OIDC flow state (state, nonce,
 * code_verifier, providerId). Expires with the browser session.
 * The code_verifier is protected by AES-GCM encryption; never stored in DB.
 */
const OIDC_STATE_COOKIE = "slb_oidc_state";

@Controller("auth/oidc")
@SkipCsrf()
export class OidcController {
  constructor(
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(CRYPTO) private readonly crypto: CryptoService,
  ) {}

  /**
   * GET /auth/oidc/:providerId/authorize
   * Discovers the IdP, builds the authorization URL with PKCE + state + nonce,
   * stores the encrypted flow state in a short-lived cookie, and redirects to IdP.
   */
  @Get(":providerId/authorize")
  async authorize(
    @Param("providerId") providerId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl, flowState } =
      await this.oidc.initiateAuthorization(providerId);

    const encryptedState = this.crypto.encrypt(JSON.stringify(flowState));

    res.cookie(OIDC_STATE_COOKIE, encryptedState, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.get("isProduction"),
      // No maxAge - session-scoped cookie
    });

    res.redirect(302, redirectUrl);
  }

  /**
   * GET /auth/oidc/:providerId/callback
   * Validates state/nonce via the encrypted flow cookie, exchanges the code for
   * tokens via PKCE, upserts the user account, issues a session cookie, clears
   * the OIDC state cookie, and redirects to the frontend.
   */
  @Get(":providerId/callback")
  async callback(
    @Param("providerId") providerId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const encryptedState = req.cookies[OIDC_STATE_COOKIE] as string | undefined;
    if (!encryptedState) {
      throw new UnauthorizedException("No OIDC flow state cookie found");
    }

    let flowState: OidcFlowState;
    try {
      const raw = this.crypto.decrypt(encryptedState);
      flowState = JSON.parse(raw) as OidcFlowState;
    } catch {
      throw new UnauthorizedException("Invalid or tampered OIDC flow state");
    }

    if (flowState.providerId !== providerId) {
      throw new NotFoundException("OIDC flow state does not match provider");
    }

    res.clearCookie(OIDC_STATE_COOKIE, { path: "/" });

    const currentUrl = this.buildCurrentUrl(req);
    const userId = await this.oidc.handleCallback(
      providerId,
      flowState,
      currentUrl,
    );

    const rawExistingCookie = req.cookies[SESSION_COOKIE] as string | undefined;
    if (rawExistingCookie) {
      const existingSessionId =
        this.sessions.verifySessionCookie(rawExistingCookie);
      if (existingSessionId) {
        await this.sessions.revokeSession(existingSessionId);
      }
    }

    const { cookieValue } = await this.sessions.createSession({ userId });

    res.cookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.get("isProduction"),
    });

    const frontendOrigin = this.config.get("FRONTEND_ORIGIN");
    res.redirect(302, frontendOrigin);
  }

  private buildCurrentUrl(req: Request): string {
    const base = this.config.get("APP_BASE_URL");
    const url = new URL(req.url, base);
    return url.href;
  }
}
