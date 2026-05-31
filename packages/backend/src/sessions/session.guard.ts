import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { SESSION_COOKIE } from "../auth/login-logout.controller.js";
import { SessionService } from "./session.service.js";
import type { SessionData } from "./session.types.js";

/** Key under which the resolved userId is attached to the request by SessionGuard. */
export const SESSION_USER_ID_KEY = "sessionUserId";

/** Key under which the validated session ID is attached to the request by SessionGuard. */
export const SESSION_ID_KEY = "sessionId";

/** Key under which the session data payload is attached to the request by SessionGuard. */
export const SESSION_DATA_KEY = "sessionData";

/**
 * Guard that validates the session cookie and enforces a fully authenticated session.
 *
 * On success it attaches three properties to the request:
 *   - `sessionUserId`  — the authenticated user ID
 *   - `sessionId`      — the raw session ID (needed for session mutations)
 *   - `sessionData`    — the typed session data payload
 *
 * Throws 401 when:
 *   - No session cookie is present or the cookie signature is invalid
 *   - The session does not exist or has expired
 *   - The session is in MFA-pending state (challenge not yet completed)
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & Record<string, unknown>>();

    const rawCookie = req.cookies[SESSION_COOKIE] as string | undefined;
    if (!rawCookie) throw new UnauthorizedException();

    const sessionId = this.sessions.verifySessionCookie(rawCookie);
    if (!sessionId) throw new UnauthorizedException();

    const session = await this.sessions.findSession(sessionId);
    if (!session) throw new UnauthorizedException();

    const data = session.data as SessionData;
    if (data.mfaPending === true) {
      throw new UnauthorizedException(
        "MFA challenge must be completed before proceeding",
      );
    }

    req[SESSION_USER_ID_KEY] = session.userId;
    req[SESSION_ID_KEY] = sessionId;
    req[SESSION_DATA_KEY] = data;

    return true;
  }
}
