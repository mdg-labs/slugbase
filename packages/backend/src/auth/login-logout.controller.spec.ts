import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";
import type { Response } from "express";

import type { AccountsService } from "../accounts/accounts.service.js";
import type { PasswordService } from "../accounts/password.service.js";
import type { ConfigService } from "../config/config.service.js";
import type { SessionService } from "../sessions/session.service.js";
import type { WorkspacesService } from "../workspaces/workspaces.service.js";
import type { MfaService } from "./mfa/mfa.service.js";
import { LoginLogoutController } from "./login-logout.controller.js";

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Test User",
    passwordHash: "hash",
    language: "en",
    theme: "auto",
    isInstanceAdmin: false,
    mfaState: "not_enrolled",
    mfaTotpSecretEncrypted: null,
    aiOptOut: false,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeResponse(): MockedObject<Response> {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as MockedObject<Response>;
}

function buildController(opts: {
  account?: ReturnType<typeof makeAccount> | null;
  passwordValid?: boolean;
  activeWorkspaceId?: string;
  workspaceError?: Error;
  mfaState?: string;
  emailVerificationRequired?: boolean;
}) {
  const accounts = {
    findByEmail: vi.fn().mockResolvedValue(opts.account ?? null),
    findById: vi.fn(),
  } as unknown as MockedObject<AccountsService>;

  const passwords = {
    verifyPassword: vi.fn().mockResolvedValue(opts.passwordValid ?? true),
  } as unknown as MockedObject<PasswordService>;

  const sessions = {
    createSession: vi
      .fn()
      .mockResolvedValue({ sessionId: "sess-1", cookieValue: "login-cookie" }),
    verifySessionCookie: vi.fn(),
    findSession: vi.fn(),
    revokeSession: vi.fn(),
  } as unknown as MockedObject<SessionService>;

  const config = {
    get: vi.fn((key: string) => {
      if (key === "isProduction") return false;
      if (key === "EMAIL_VERIFICATION_REQUIRED") return opts.emailVerificationRequired ?? false;
      return undefined;
    }),
  } as unknown as MockedObject<ConfigService>;

  const mfa = {} as unknown as MockedObject<MfaService>;

  const workspaces = {
    resolveDefaultActiveWorkspaceId: opts.workspaceError
      ? vi.fn().mockRejectedValue(opts.workspaceError)
      : vi.fn().mockResolvedValue(opts.activeWorkspaceId ?? "ws-1"),
  } as unknown as MockedObject<WorkspacesService>;

  const controller = new LoginLogoutController(
    accounts,
    passwords,
    sessions,
    config,
    mfa,
    workspaces,
  );

  return { controller, accounts, passwords, sessions, workspaces, config };
}

describe("LoginLogoutController.login()", () => {
  it("creates a session with activeWorkspaceId on successful login", async () => {
    const { controller, sessions, workspaces } = buildController({
      account: makeAccount(),
      activeWorkspaceId: "ws-default",
    });
    const res = makeResponse();

    const result = await controller.login(
      { email: "user@example.com", password: "secret" },
      res,
    );

    expect(workspaces.resolveDefaultActiveWorkspaceId).toHaveBeenCalledWith(
      "user-1",
    );
    expect(sessions.createSession).toHaveBeenCalledWith({
      userId: "user-1",
      data: { activeWorkspaceId: "ws-default" },
    });
    expect(result).toEqual({ userId: "user-1" });
    expect(res.cookie).toHaveBeenCalled();
  });

  it("sets emailVerificationPending when verification is required and user is unverified", async () => {
    const { controller, sessions } = buildController({
      account: makeAccount({ emailVerified: false }),
      activeWorkspaceId: "ws-1",
      emailVerificationRequired: true,
    });
    const res = makeResponse();

    const result = await controller.login(
      { email: "user@example.com", password: "secret" },
      res,
    );

    expect(sessions.createSession).toHaveBeenCalledWith({
      userId: "user-1",
      data: {
        activeWorkspaceId: "ws-1",
        emailVerificationPending: true,
      },
    });
    expect(result).toEqual({
      userId: "user-1",
      emailVerificationRequired: true,
    });
  });

  it("does not set emailVerificationPending when verification is not required", async () => {
    const { controller, sessions } = buildController({
      account: makeAccount({ emailVerified: false }),
      activeWorkspaceId: "ws-1",
      emailVerificationRequired: false,
    });
    const res = makeResponse();

    const result = await controller.login(
      { email: "user@example.com", password: "secret" },
      res,
    );

    expect(sessions.createSession).toHaveBeenCalledWith({
      userId: "user-1",
      data: { activeWorkspaceId: "ws-1" },
    });
    expect(result).toEqual({ userId: "user-1" });
  });

  it("returns 403 when the user has no workspace memberships", async () => {
    const { controller } = buildController({
      account: makeAccount(),
      workspaceError: new ForbiddenException(
        "No workspace membership found - join a workspace or complete registration",
      ),
    });
    const res = makeResponse();

    await expect(
      controller.login(
        { email: "user@example.com", password: "secret" },
        res,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("returns 401 for invalid credentials without resolving workspace", async () => {
    const { controller, workspaces } = buildController({
      account: null,
    });
    const res = makeResponse();

    await expect(
      controller.login(
        { email: "user@example.com", password: "secret" },
        res,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(workspaces.resolveDefaultActiveWorkspaceId).not.toHaveBeenCalled();
  });

  it("does not set activeWorkspaceId on MFA-pending login", async () => {
    const { controller, sessions, workspaces } = buildController({
      account: makeAccount({ mfaState: "enrolled" }),
    });
    const res = makeResponse();

    const result = await controller.login(
      { email: "user@example.com", password: "secret" },
      res,
    );

    expect(result).toEqual({ mfaRequired: true });
    expect(workspaces.resolveDefaultActiveWorkspaceId).not.toHaveBeenCalled();
    expect(sessions.createSession).toHaveBeenCalledWith({
      userId: "user-1",
      data: { mfaPending: true },
    });
  });
});
