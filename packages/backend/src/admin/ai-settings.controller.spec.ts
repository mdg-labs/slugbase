import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { AiSettings } from "@slugbase/shared-types";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { WorkspacesService } from "../workspaces/workspaces.service.js";
import { TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import { EMPTY_WORKSPACE_BILLING } from "../workspaces/workspace.types.js";
import { AiSettingsController } from "./ai-settings.controller.js";
import type { AiSettingsService } from "./ai-settings.service.js";

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

const MOCK_AI_SETTINGS: AiSettings = {
  provider: "openai",
  hasApiKey: false,
  model: "gpt-4o-mini",
  enabled: false,
};

function buildController(opts: { roleAllowed?: boolean; settings?: AiSettings }) {
  const aiSettings = {
    getSettings: vi.fn().mockResolvedValue(opts.settings ?? MOCK_AI_SETTINGS),
    updateSettings: vi.fn().mockResolvedValue(opts.settings ?? MOCK_AI_SETTINGS),
  } as unknown as MockedObject<AiSettingsService>;

  const workspaces = {
    requireWorkspaceRole: vi.fn(() => {
      if (opts.roleAllowed === false) {
        throw new ForbiddenException("Requires ADMIN or higher");
      }
      return Promise.resolve();
    }),
  } as unknown as MockedObject<WorkspacesService>;

  const controller = new AiSettingsController(aiSettings, workspaces);
  return { controller, aiSettings, workspaces };
}

describe("AiSettingsController.getSettings", () => {
  it("returns settings for an ADMIN user", async () => {
    const { controller } = buildController({});
    const result = await controller.getSettings(makeWorkspace(), makeReq() as never);
    expect(result).toEqual(MOCK_AI_SETTINGS);
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.getSettings(makeWorkspace(), makeReq() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never includes encrypted API key in response", async () => {
    const { controller } = buildController({ settings: { ...MOCK_AI_SETTINGS, hasApiKey: true } });
    const result = await controller.getSettings(makeWorkspace(), makeReq() as never);
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("encryptedApiKey");
    expect(result).toHaveProperty("hasApiKey");
  });
});

describe("AiSettingsController.updateSettings", () => {
  it("updates and returns settings", async () => {
    const { controller, aiSettings } = buildController({});
    const body = { provider: "openai" as const, model: "gpt-4o-mini", enabled: true };
    const result = await controller.updateSettings(makeWorkspace(), makeReq() as never, body);
    expect(aiSettings.updateSettings).toHaveBeenCalledWith(body);
    expect(result).toEqual(MOCK_AI_SETTINGS);
  });

  it("does not expose encrypted key after setting", async () => {
    const { controller } = buildController({
      settings: { ...MOCK_AI_SETTINGS, hasApiKey: true },
    });
    const result = await controller.updateSettings(makeWorkspace(), makeReq() as never, {
      apiKey: "sk-some-key",
    });
    expect(result.hasApiKey).toBe(true);
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("encryptedApiKey");
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.updateSettings(makeWorkspace(), makeReq() as never, { enabled: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
