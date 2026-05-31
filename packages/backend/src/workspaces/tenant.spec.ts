import {
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../sessions/session.types.js";
import { ACTIVE_WORKSPACE_KEY } from "./tenant.guard.js";
import type { WorkspaceRecord } from "./workspace.types.js";
import { EMPTY_WORKSPACE_BILLING } from "./workspace.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 86400_000),
    createdAt: new Date(),
    lastActivityAt: new Date(),
    data: {},
    ...overrides,
  };
}

function makeWorkspace(id = "ws-1"): WorkspaceRecord {
  return {
    id,
    name: "Test Workspace",
    slug: "test-workspace",
    plan: "free",
    planSeats: null,
    planArchived: false,
    ...EMPTY_WORKSPACE_BILLING,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// TenantGuard unit tests
// ---------------------------------------------------------------------------

describe("TenantGuard — session and membership validation", () => {
  async function buildGuard(opts: {
    session: SessionRecord | null;
    workspaceExists?: boolean;
    isMember?: boolean;
  }) {
    const { TenantGuard } = await import("./tenant.guard.js");

    const sessionsMock = {
      verifySessionCookie: (_cookie: string): string | null => "sess-1",
      findSession: (_id: string) => Promise.resolve(opts.session),
    };

    const workspacesMock = {
      requireWorkspaceRole: opts.isMember === false
        ? () => Promise.reject(new ForbiddenException("Not a member of this workspace"))
        : () => Promise.resolve(undefined),
      getWorkspace: opts.workspaceExists === false
        ? async () => {
            const { NotFoundException } = await import("@nestjs/common");
            throw new NotFoundException("Workspace not found");
          }
        : () => Promise.resolve(makeWorkspace("ws-1")),
    };

    return new TenantGuard(sessionsMock as never, workspacesMock as never);
  }

  interface FakeContext {
    switchToHttp(): { getRequest(): Record<string, unknown> };
    req: Record<string, unknown>;
  }

  function fakeContext(cookiePresent = true): FakeContext {
    const req: Record<string, unknown> = {
      cookies: cookiePresent ? { slb_session: "raw-cookie-value" } : {},
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      req,
    };
  }

  it("throws 401 when session cookie is absent", async () => {
    const guard = await buildGuard({ session: null });
    await expect(guard.canActivate(fakeContext(false) as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("throws 401 when session is not found", async () => {
    const guard = await buildGuard({ session: null });
    await expect(guard.canActivate(fakeContext() as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("throws 401 when session is MFA-pending", async () => {
    const session = makeSession({ data: { mfaPending: true } });
    const guard = await buildGuard({ session });
    await expect(guard.canActivate(fakeContext() as never)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("throws 403 when no activeWorkspaceId is set in session data", async () => {
    const session = makeSession({ data: {} });
    const guard = await buildGuard({ session });
    await expect(guard.canActivate(fakeContext() as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("throws 403 when user is not a member of the active workspace", async () => {
    const session = makeSession({ data: { activeWorkspaceId: "ws-1" } });
    const guard = await buildGuard({ session, isMember: false });
    await expect(guard.canActivate(fakeContext() as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("throws 403 when the active workspace no longer exists", async () => {
    const session = makeSession({ data: { activeWorkspaceId: "ws-deleted" } });
    const guard = await buildGuard({ session, workspaceExists: false, isMember: true });
    await expect(guard.canActivate(fakeContext() as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("attaches the workspace to the request on success", async () => {
    const session = makeSession({ data: { activeWorkspaceId: "ws-1" } });
    const guard = await buildGuard({ session, isMember: true, workspaceExists: true });
    const ctx = fakeContext();
    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect(ctx.req[ACTIVE_WORKSPACE_KEY]).toMatchObject({ id: "ws-1" });
  });
});

// ---------------------------------------------------------------------------
// SessionData type contract — activeWorkspaceId field
// ---------------------------------------------------------------------------

describe("SessionData — activeWorkspaceId contract", () => {
  it("stores and retrieves activeWorkspaceId", () => {
    const data: import("../sessions/session.types.js").SessionData = {
      activeWorkspaceId: "ws-42",
    };
    expect(data.activeWorkspaceId).toBe("ws-42");
  });

  it("activeWorkspaceId is optional (absent by default)", () => {
    const data: import("../sessions/session.types.js").SessionData = {};
    expect(data.activeWorkspaceId).toBeUndefined();
  });

  it("SessionData carries mfaPending and emailVerificationPending too", () => {
    const data: import("../sessions/session.types.js").SessionData = {
      mfaPending: true,
      emailVerificationPending: false,
      activeWorkspaceId: undefined,
    };
    expect(data.mfaPending).toBe(true);
    expect(data.emailVerificationPending).toBe(false);
  });
});
