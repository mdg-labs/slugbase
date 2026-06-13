import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { WorkspaceRecord } from "../../workspaces/workspace.types.js";
import type { WorkspacesService } from "../../workspaces/workspaces.service.js";
import { TENANT_USER_ID_KEY } from "../../workspaces/tenant.guard.js";
import { EMPTY_WORKSPACE_BILLING } from "../../workspaces/workspace.types.js";
import { OidcAdminController } from "./oidc-admin.controller.js";
import type { OidcService } from "./oidc.service.js";
import type { OidcProviderRecord } from "./oidc.types.js";

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

function makeReq(userId = "user-1"): Record<string, unknown> {
  return { [TENANT_USER_ID_KEY]: userId };
}

function makeProviderRecord(id = "provider-1"): OidcProviderRecord {
  return {
    id,
    name: "Test IdP",
    issuerUrl: "https://idp.example.com",
    clientId: "client-123",
    clientSecretEncrypted: "aes:encrypted-secret",
    scopes: "openid email profile",
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function buildController(opts: { roleAllowed?: boolean; providers?: OidcProviderRecord[] }) {
  const providers = opts.providers ?? [makeProviderRecord()];

  const oidc = {
    listProviders: vi.fn().mockResolvedValue(providers),
    createProvider: vi.fn().mockResolvedValue(makeProviderRecord()),
    updateProvider: vi.fn().mockResolvedValue(makeProviderRecord()),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockedObject<OidcService>;

  const workspaces = {
    requireWorkspaceRole: vi.fn(() => {
      if (opts.roleAllowed === false) {
        throw new ForbiddenException("Requires ADMIN or higher");
      }
      return Promise.resolve();
    }),
  } as unknown as MockedObject<WorkspacesService>;

  const controller = new OidcAdminController(oidc, workspaces);
  return { controller, oidc, workspaces };
}

describe("OidcAdminController.listProviders", () => {
  it("returns list of public provider objects for ADMIN", async () => {
    const { controller } = buildController({});
    const result = await controller.listProviders(makeWorkspace(), makeReq() as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "provider-1", hasClientSecret: true });
    expect(result[0]).not.toHaveProperty("clientSecretEncrypted");
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.listProviders(makeWorkspace(), makeReq() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never exposes encrypted client secrets", async () => {
    const { controller } = buildController({});
    const result = await controller.listProviders(makeWorkspace(), makeReq() as never);
    for (const provider of result) {
      expect(provider).not.toHaveProperty("clientSecretEncrypted");
      expect(provider).not.toHaveProperty("clientSecret");
    }
  });
});

describe("OidcAdminController.createProvider", () => {
  it("creates and returns a public provider for ADMIN", async () => {
    const { controller } = buildController({});
    const body = {
      name: "New IdP",
      issuerUrl: "https://new-idp.example.com",
      clientId: "new-client",
      clientSecret: "new-secret",
    };
    const result = await controller.createProvider(makeWorkspace(), makeReq() as never, body);
    expect(result).toMatchObject({ hasClientSecret: true });
    expect(result).not.toHaveProperty("clientSecretEncrypted");
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.createProvider(makeWorkspace(), makeReq() as never, {
        name: "IdP",
        issuerUrl: "https://idp.example.com",
        clientId: "cid",
        clientSecret: "secret",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("OidcAdminController.updateProvider", () => {
  it("updates and returns a public provider for ADMIN", async () => {
    const { controller } = buildController({});
    const result = await controller.updateProvider(
      makeWorkspace(),
      makeReq() as never,
      "provider-1",
      { enabled: false },
    );
    expect(result).not.toHaveProperty("clientSecretEncrypted");
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.updateProvider(makeWorkspace(), makeReq() as never, "provider-1", { enabled: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("OidcAdminController.deleteProvider", () => {
  it("deletes a provider for ADMIN", async () => {
    const { controller, oidc } = buildController({});
    await controller.deleteProvider(makeWorkspace(), makeReq() as never, "provider-1");
    expect(oidc.deleteProvider).toHaveBeenCalledWith("provider-1");
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.deleteProvider(makeWorkspace(), makeReq() as never, "provider-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("propagates NotFoundException from service when provider not found", async () => {
    const { controller, oidc } = buildController({});
    oidc.deleteProvider.mockRejectedValue(new NotFoundException("OIDC provider not found"));
    await expect(
      controller.deleteProvider(makeWorkspace(), makeReq() as never, "unknown-id"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
