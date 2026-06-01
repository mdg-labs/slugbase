import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { SESSION_COOKIE } from "../auth/login-logout.controller.js";
import { ConfigService } from "../config/config.service.js";
import { SessionService } from "../sessions/session.service.js";
import type { SessionData } from "../sessions/session.types.js";
import type { WorkspaceRecord } from "./workspace.types.js";
import { WorkspacesService } from "./workspaces.service.js";

/** Key under which the resolved WorkspaceRecord is attached to the request by TenantGuard. */
export const ACTIVE_WORKSPACE_KEY = "activeWorkspace";

/** Key under which the authenticated user ID is attached to the request by TenantGuard. */
export const TENANT_USER_ID_KEY = "tenantUserId";

/** Key under which the validated session ID is attached to the request by TenantGuard. */
export const TENANT_SESSION_ID_KEY = "tenantSessionId";

/**
 * Guard that resolves the active workspace tenant context from the server-side session.
 *
 * Performs these checks in order:
 *   1. Reads and validates the session cookie → 401 if missing, invalid, or expired
 *   2. Rejects MFA-pending sessions → 401
 *   3. Rejects email-verification-pending sessions when required → 403 (spec §5.5)
 *   4. Reads `activeWorkspaceId` from session data → 403 if not set
 *   5. Verifies the user is still a member of the active workspace → 403
 *   6. Verifies the workspace still exists → 403
 *
 * On success, attaches to the request:
 *   - `activeWorkspace` — the resolved WorkspaceRecord (use via @ActiveWorkspace())
 *   - `tenantUserId`    — the authenticated user ID
 *   - `tenantSessionId` — the session ID (for downstream session mutations)
 *
 * Spec §4.3, §5.9.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(ConfigService) private readonly config: ConfigService,
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

    if (
      this.config.get("EMAIL_VERIFICATION_REQUIRED") &&
      data.emailVerificationPending === true
    ) {
      throw new ForbiddenException(
        "Email address must be verified before accessing workspace data",
      );
    }

    const activeWorkspaceId = data.activeWorkspaceId;
    if (!activeWorkspaceId) {
      throw new ForbiddenException(
        "No active workspace selected — call POST /workspaces/:id/activate first",
      );
    }

    let workspace: WorkspaceRecord;
    try {
      await this.workspaces.requireWorkspaceRole(
        activeWorkspaceId,
        session.userId,
        "MEMBER",
      );
      workspace = await this.workspaces.getWorkspace(activeWorkspaceId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new ForbiddenException("Active workspace no longer exists");
      }
      throw err;
    }

    req[ACTIVE_WORKSPACE_KEY] = workspace;
    req[TENANT_USER_ID_KEY] = session.userId;
    req[TENANT_SESSION_ID_KEY] = sessionId;

    return true;
  }
}
