import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { AccountsService } from "../accounts/accounts.service.js";
import type { ConfigService } from "../config/config.service.js";
import type { InstanceMetadataRepository } from "../db/instance-metadata.repository.js";
import type { SessionService } from "../sessions/session.service.js";
import type { EmailVerificationService } from "../auth/verification/email-verification.service.js";
import type { WorkspacesService } from "../workspaces/workspaces.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { EMPTY_WORKSPACE_BILLING } from "../workspaces/workspace.types.js";

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-1",
    name: "Admin Workspace",
    slug: "admin",
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
  userCount?: number;
  setupComplete?: string | null;
  publicRegistration?: boolean;
  emailVerificationRequired?: boolean;
}) {
  const { SetupService } = await import("./setup.service.js");

  const accounts = {
    countAll: vi.fn().mockResolvedValue(opts.userCount ?? 0),
    registerAccount: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@example.com",
      name: "Admin",
      passwordHash: "hash",
      language: "en",
      theme: "auto",
      isInstanceAdmin: true,
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
    createSession: vi.fn().mockResolvedValue({ sessionId: "sess-1", cookieValue: "cookie-val" }),
  } as unknown as MockedObject<SessionService>;

  const config = {
    get: vi.fn((key: string) => {
      if (key === "EMAIL_VERIFICATION_REQUIRED") return opts.emailVerificationRequired ?? false;
      if (key === "isProduction") return false;
      return undefined;
    }),
  } as unknown as MockedObject<ConfigService>;

  const instanceMetadata = {
    get: vi.fn().mockResolvedValue(opts.setupComplete ?? null),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockedObject<InstanceMetadataRepository>;

  const emailVerification = {
    issueToken: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockedObject<EmailVerificationService>;

  const service = new SetupService(
    accounts,
    workspaces,
    sessions,
    config,
    instanceMetadata,
    emailVerification,
  );

  return { service, accounts, workspaces, sessions, config, instanceMetadata, emailVerification };
}

describe("SetupService.getStatus()", () => {
  it("returns needsSetup: true when no users exist", async () => {
    const { service } = await buildService({ userCount: 0 });
    await expect(service.getStatus()).resolves.toEqual({ needsSetup: true });
  });

  it("returns needsSetup: false when users exist", async () => {
    const { service } = await buildService({ userCount: 1 });
    await expect(service.getStatus()).resolves.toEqual({ needsSetup: false });
  });

  it("returns needsSetup: false when multiple users exist", async () => {
    const { service } = await buildService({ userCount: 5 });
    await expect(service.getStatus()).resolves.toEqual({ needsSetup: false });
  });
});

describe("SetupService.completeSetup()", () => {
  const validDto = {
    email: "admin@example.com",
    name: "Admin User",
    password: "securePassword123!",
    workspaceName: "Admin Workspace",
    workspaceSlug: "admin",
  };

  it("creates the admin account with isInstanceAdmin=true", async () => {
    const { service, accounts } = await buildService({ userCount: 0 });
    await service.completeSetup(validDto);
    expect(accounts.registerAccount).toHaveBeenCalledWith(
      expect.objectContaining({ isInstanceAdmin: true }),
    );
  });

  it("creates a workspace after creating the account", async () => {
    const { service, workspaces } = await buildService({ userCount: 0 });
    await service.completeSetup(validDto);
    expect(workspaces.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Admin Workspace", slug: "admin" }),
      "user-1",
    );
  });

  it("creates a session with activeWorkspaceId", async () => {
    const { service, sessions } = await buildService({ userCount: 0 });
    await service.completeSetup(validDto);
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeWorkspaceId: "ws-1" }),
      }),
    );
  });

  it("marks setup complete in instance_metadata", async () => {
    const { service, instanceMetadata } = await buildService({ userCount: 0 });
    await service.completeSetup(validDto);
    expect(instanceMetadata.set).toHaveBeenCalledWith("setup_complete", "true");
  });

  it("throws ConflictException when setup_complete flag is already set", async () => {
    const { service } = await buildService({
      userCount: 0,
      setupComplete: "true",
    });
    await expect(service.completeSetup(validDto)).rejects.toThrow(ConflictException);
  });

  it("throws ConflictException when users already exist (even without flag)", async () => {
    const { service } = await buildService({ userCount: 1, setupComplete: null });
    await expect(service.completeSetup(validDto)).rejects.toThrow(ConflictException);
  });

  it("does not issue verification email when EMAIL_VERIFICATION_REQUIRED is false", async () => {
    const { service, emailVerification } = await buildService({
      userCount: 0,
      emailVerificationRequired: false,
    });
    await service.completeSetup(validDto);
    expect(emailVerification.issueToken).not.toHaveBeenCalled();
  });

  it("issues verification email when EMAIL_VERIFICATION_REQUIRED is true", async () => {
    const { service, emailVerification } = await buildService({
      userCount: 0,
      emailVerificationRequired: true,
    });
    await service.completeSetup(validDto);
    expect(emailVerification.issueToken).toHaveBeenCalledWith("user-1", "admin@example.com");
  });

  it("sets emailVerificationPending in session when required", async () => {
    const { service, sessions } = await buildService({
      userCount: 0,
      emailVerificationRequired: true,
    });
    await service.completeSetup(validDto);
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emailVerificationPending: true }),
      }),
    );
  });

  it("returns userId and cookieValue", async () => {
    const { service } = await buildService({ userCount: 0 });
    const result = await service.completeSetup(validDto);
    expect(result).toMatchObject({ userId: "user-1", cookieValue: "cookie-val" });
  });
});
