import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { ApiTokenService } from "./api-token.service.js";

/** Key under which the resolved userId is attached to the request. */
export const BEARER_USER_ID_KEY = "bearerUserId";

/**
 * Guard that accepts `Authorization: Bearer <token>` requests.
 * On success, sets `request.bearerUserId` to the resolved user ID.
 * Does not create a cookie session - the request is stateless.
 * API tokens bypass MFA per spec §5.3.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    @Inject(ApiTokenService) private readonly apiTokenService: ApiTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { [BEARER_USER_ID_KEY]?: string }>();
    const rawHeader = req.headers.authorization;

    if (!rawHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Bearer token required");
    }

    const rawToken = rawHeader.slice("Bearer ".length).trim();
    const record = await this.apiTokenService.verifyToken(rawToken);

    if (!record) {
      throw new UnauthorizedException("Invalid or expired API token");
    }

    req[BEARER_USER_ID_KEY] = record.userId;
    return true;
  }
}
