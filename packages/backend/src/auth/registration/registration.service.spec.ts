import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { AccountsService } from "../../accounts/accounts.service.js";
import type { ConfigService } from "../../config/config.service.js";
import type { SessionService } from "../../sessions/session.service.js";
import type { EmailVerificationService } from "../verification/email-verification.service.js";
import type { WorkspacesService } from "../../workspaces/workspaces.service.js";
import type { WorkspaceRecord } from "../../workspaces/workspace.types.js";
import { EMPTY_WORKSPACE_BILLING } from "../../workspaces/workspace.types.js";

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-2",
    name: "User Workspace",
    slug: "user-ws",
    plan: "free",
    planSeats: null,
    planArchived: false,
    ...EMPTY_WORKSPACE_BILLING,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function buildService(opts: {
  publicRegistration?: boolean;
  emailVerificationRequired?: boolean;
}) {
  const { RegistrationService } = await import("./registration.service.js");

  const accounts = {
    registerAccount: vi.fn().mockResolvedValue({
      id: "user-reg-1",
      email: "user@example.com",
      name: "Test User",
      passwordHash: "hash",
      language: "en",
      theme: "auto",
      isInstanceAdmin: false,
      mfaState: "not_enrolled",
      mfaTotpSecretEncrypted: null,
      aiOptOut: false,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as unknown as MockedObject<AccountsService>;

  const workspaces = {
    createWorkspace: vi.fn().mockResolvedValue(makeWorkspace()),
  } as unknown as MockedObject<WorkspacesService>;

  const sessions = {
    createSession: vi.fn().mockResolvedValue({ sessionId: "sess-2", cookieValue: "reg-cookie" }),
  } as unknown as MockedObject<SessionService>;

  const config = {
    get: vi.fn((key: string) => {
      if (key === "PUBLIC_REGISTRATION") return opts.publicRegistration ?? true;
      if (key === "EMAIL_VERIFICATION_REQUIRED") return opts.emailVerificationRequired ?? false;
      if (key === "isProduction") return false;
      return undefined;
    }),
  } as unknown as MockedObject<ConfigService>;

  const emailVerification = {
    issueToken: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockedObject<EmailVerificationService>;

  const service = new RegistrationService(
    accounts,
    workspaces,
    sessions,
    config,
    emailVerification,
  );

  return { service, accounts, workspaces, sessions, config, emailVerification };
}

describe("RegistrationService.register()", () => {
  const validDto = {
    email: "user@example.com",
    name: "Test User",
    password: "securePass123!",
  };

  it("creates the account without isInstanceAdmin", async () => {
    const { service, accounts } = await buildService({ publicRegistration: true });
    await service.register(validDto);
    expect(accounts.registerAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        name: "Test User",
      }),
    );
    expect(accounts.registerAccount).not.toHaveBeenCalledWith(
      expect.objectContaining({ isInstanceAdmin: true }),
    );
  });

  it("creates a workspace for the new user", async () => {
    const { service, workspaces } = await buildService({ publicRegistration: true });
    await service.register(validDto);
    expect(workspaces.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "free" }),
      "user-reg-1",
    );
  });

  it("creates a session with activeWorkspaceId set", async () => {
    const { service, sessions } = await buildService({ publicRegistration: true });
    await service.register(validDto);
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeWorkspaceId: "ws-2" }),
      }),
    );
  });

  it("throws ForbiddenException when PUBLIC_REGISTRATION is false", async () => {
    const { service } = await buildService({ publicRegistration: false });
    await expect(service.register(validDto)).rejects.toThrow(ForbiddenException);
  });

  it("does not create account when registration is disabled", async () => {
    const { service, accounts } = await buildService({ publicRegistration: false });
    await expect(service.register(validDto)).rejects.toThrow(ForbiddenException);
    expect(accounts.registerAccount).not.toHaveBeenCalled();
  });

  it("does not issue verification email when EMAIL_VERIFICATION_REQUIRED is false", async () => {
    const { service, emailVerification } = await buildService({
      publicRegistration: true,
      emailVerificationRequired: false,
    });
    await service.register(validDto);
    expect(emailVerification.issueToken).not.toHaveBeenCalled();
  });

  it("issues verification email when EMAIL_VERIFICATION_REQUIRED is true", async () => {
    const { service, emailVerification } = await buildService({
      publicRegistration: true,
      emailVerificationRequired: true,
    });
    await service.register(validDto);
    expect(emailVerification.issueToken).toHaveBeenCalledWith("user-reg-1", "user@example.com");
  });

  it("sets emailVerificationPending in session when required", async () => {
    const { service, sessions } = await buildService({
      publicRegistration: true,
      emailVerificationRequired: true,
    });
    await service.register(validDto);
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emailVerificationPending: true }),
      }),
    );
  });

  it("returns userId and cookieValue on success", async () => {
    const { service } = await buildService({ publicRegistration: true });
    const result = await service.register(validDto);
    expect(result).toMatchObject({ userId: "user-reg-1", cookieValue: "reg-cookie" });
  });

  it("accepts custom workspaceName and workspaceSlug", async () => {
    const { service, workspaces } = await buildService({ publicRegistration: true });
    await service.register({
      ...validDto,
      workspaceName: "My Custom Workspace",
      workspaceSlug: "my-custom",
    });
    expect(workspaces.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Custom Workspace", slug: "my-custom" }),
      "user-reg-1",
    );
  });
});
