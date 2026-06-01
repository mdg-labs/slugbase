import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { MailService, MailSettings } from "@slugbase/shared-types";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { WorkspacesService } from "../workspaces/workspaces.service.js";
import { TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import { EMPTY_WORKSPACE_BILLING } from "../workspaces/workspace.types.js";
import { MailSettingsController } from "./mail-settings.controller.js";
import type { MailSettingsService } from "./mail-settings.service.js";

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

const MOCK_SETTINGS: MailSettings = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "user@example.com",
  hasPassword: true,
  from: "noreply@example.com",
};

function buildController(opts: {
  roleAllowed?: boolean;
  mailAvailable?: boolean;
  settings?: MailSettings;
}) {
  const mailSettings = {
    getSettings: vi.fn().mockResolvedValue(opts.settings ?? MOCK_SETTINGS),
    updateSettings: vi.fn().mockResolvedValue(opts.settings ?? MOCK_SETTINGS),
  } as unknown as MockedObject<MailSettingsService>;

  const workspaces = {
    requireWorkspaceRole: vi.fn(() => {
      if (opts.roleAllowed === false) {
        throw new ForbiddenException("Requires ADMIN or higher");
      }
      return Promise.resolve();
    }),
  } as unknown as MockedObject<WorkspacesService>;

  const mail = {
    isAvailable: vi.fn().mockReturnValue(opts.mailAvailable ?? true),
    sendTest: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockedObject<MailService>;

  const controller = new MailSettingsController(mailSettings, workspaces, mail);
  return { controller, mailSettings, workspaces, mail };
}

describe("MailSettingsController.getSettings", () => {
  it("returns settings for an ADMIN user", async () => {
    const { controller } = buildController({});
    const result = await controller.getSettings(makeWorkspace(), makeReq() as never);
    expect(result).toEqual(MOCK_SETTINGS);
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.getSettings(makeWorkspace(), makeReq() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never includes encrypted password in response", async () => {
    const { controller } = buildController({
      settings: { ...MOCK_SETTINGS, hasPassword: true },
    });
    const result = await controller.getSettings(makeWorkspace(), makeReq() as never);
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("encryptedPass");
    expect(result).toHaveProperty("hasPassword");
  });
});

describe("MailSettingsController.updateSettings", () => {
  it("updates and returns settings", async () => {
    const { controller, mailSettings } = buildController({});
    const body = { host: "mail.example.com", port: 465, secure: true };
    const result = await controller.updateSettings(makeWorkspace(), makeReq() as never, body);
    expect(mailSettings.updateSettings).toHaveBeenCalledWith(body);
    expect(result).toEqual(MOCK_SETTINGS);
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.updateSettings(makeWorkspace(), makeReq() as never, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("MailSettingsController.sendTest", () => {
  it("calls mail.sendTest on happy path", async () => {
    const { controller, mail } = buildController({});
    await controller.sendTest(makeWorkspace(), makeReq() as never, { to: "admin@example.com" });
    expect(mail.sendTest).toHaveBeenCalledWith("admin@example.com");
  });

  it("throws ServiceUnavailableException when mail is not available", async () => {
    const { controller } = buildController({ mailAvailable: false });
    await expect(
      controller.sendTest(makeWorkspace(), makeReq() as never, { to: "admin@example.com" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("throws ForbiddenException when user is not ADMIN", async () => {
    const { controller } = buildController({ roleAllowed: false });
    await expect(
      controller.sendTest(makeWorkspace(), makeReq() as never, { to: "admin@example.com" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
