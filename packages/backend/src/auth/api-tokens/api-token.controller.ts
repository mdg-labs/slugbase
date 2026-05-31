import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { SessionService } from "../../sessions/session.service.js";
import { SESSION_COOKIE } from "../login-logout.controller.js";
import { ApiTokenService } from "./api-token.service.js";
import type { ApiTokenSummary } from "./api-token.types.js";

interface CreateTokenBody {
  name: string;
}

interface CreateTokenResponse {
  token: ApiTokenSummary;
  /** Plaintext — shown exactly once. */
  plaintext: string;
}

@Controller("auth/api-tokens")
export class ApiTokenController {
  constructor(
    @Inject(ApiTokenService) private readonly apiTokenService: ApiTokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * Create a new named API token. Requires a fully authenticated session.
   * Returns the plaintext token exactly once.
   */
  @Post()
  @HttpCode(201)
  async createToken(
    @Req() req: Request,
    @Body() body: CreateTokenBody,
  ): Promise<CreateTokenResponse> {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException("name is required");
    }

    const userId = await this.requireSessionUserId(req);
    const result = await this.apiTokenService.createToken(userId, body.name.trim());
    return { token: result.record, plaintext: result.plaintext };
  }

  /**
   * List all API tokens for the current user.
   * Accepts both session auth and `Authorization: Bearer <token>`.
   * Never returns the token hash.
   */
  @Get()
  async listTokens(@Req() req: Request): Promise<{ tokens: ApiTokenSummary[] }> {
    const userId = await this.resolveUserId(req);
    const tokens = await this.apiTokenService.listTokens(userId);
    return { tokens };
  }

  /**
   * Delete an API token by ID. Requires a fully authenticated session.
   */
  @Delete(":id")
  @HttpCode(200)
  async deleteToken(
    @Req() req: Request,
    @Param("id") id: string,
  ): Promise<{ ok: true }> {
    if (!id) throw new BadRequestException("Token ID is required");
    const userId = await this.requireSessionUserId(req);
    await this.apiTokenService.deleteToken(userId, id);
    return { ok: true };
  }

  /**
   * Resolves the user ID from either a Bearer token or a full session cookie.
   * Checks bearer first; falls back to session.
   */
  private async resolveUserId(req: Request): Promise<string> {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const rawToken = authHeader.slice("Bearer ".length).trim();
      const record = await this.apiTokenService.verifyToken(rawToken);
      if (!record) throw new UnauthorizedException("Invalid or expired API token");
      return record.userId;
    }

    return this.requireSessionUserId(req);
  }

  /** Resolves a fully authenticated (non-MFA-pending) session user ID. */
  private async requireSessionUserId(req: Request): Promise<string> {
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

    return session.userId;
  }
}
