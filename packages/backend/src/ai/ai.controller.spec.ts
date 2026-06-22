import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { describe, expect, it, vi, type MockedObject } from "vitest";

import type { AccountsService } from "../accounts/accounts.service.js";
import type { AiSettingsService } from "../admin/ai-settings.service.js";
import type { EntitlementsService } from "../entitlements/entitlements.service.js";
import { TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { AiSuggestionCacheService } from "./cache/ai-suggestion-cache.service.js";
import { AiController } from "./ai.controller.js";
import type { AiService, AiSuggestions } from "@slugbase/shared-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(
  plan: WorkspaceRecord["plan"] = "personal",
): WorkspaceRecord {
  return {
    id: "ws-1",
    name: "Test Workspace",
    slug: "test",
    plan,
    planSeats: null,
    planArchived: false,
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingStatus: null,
    billingPeriodEnd: null,
    permanentPersonal: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Test User",
    passwordHash: "hash",
    language: "en",
    theme: "dark",
    accentColor: null,
    isInstanceAdmin: false,
    mfaState: "not_enrolled" as const,
    mfaTotpSecretEncrypted: null,
    aiOptOut: false,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const MOCK_SUGGESTIONS: AiSuggestions = {
  title: "Example Site",
  slug: "example-site",
  tags: ["web", "demo"],
  detectedLanguage: "en",
  confidence: 0.9,
};

const SUGGEST_BODY = { url: "https://example.com", outputLanguage: "en" };

function makeReq(userId = "user-1"): Record<string, unknown> {
  return { [TENANT_USER_ID_KEY]: userId };
}

function buildController(opts: {
  aiAvailable?: boolean;
  workspaceEnabled?: boolean;
  aiOptOut?: boolean;
  accountFound?: boolean;
  entitlementAllowed?: boolean;
  suggestWithCacheResult?: AiSuggestions | Error;
}) {
  const ai = {
    isAvailable: vi.fn().mockReturnValue(opts.aiAvailable ?? true),
    suggest: vi.fn(),
  } as unknown as MockedObject<AiService>;

  const aiSettings = {
    isWorkspaceEnabled: vi
      .fn()
      .mockResolvedValue(opts.workspaceEnabled ?? true),
  } as unknown as MockedObject<AiSettingsService>;

  const cache = {
    suggestWithCache:
      opts.suggestWithCacheResult instanceof Error
        ? vi.fn().mockRejectedValue(opts.suggestWithCacheResult)
        : vi
            .fn()
            .mockResolvedValue(
              opts.suggestWithCacheResult ?? MOCK_SUGGESTIONS,
            ),
  } as unknown as MockedObject<AiSuggestionCacheService>;

  const accounts = {
    findById: vi.fn().mockResolvedValue(
      opts.accountFound === false
        ? null
        : makeAccount({ aiOptOut: opts.aiOptOut ?? false }),
    ),
  } as unknown as MockedObject<AccountsService>;

  const entitlements = {
    assertCan: vi.fn(() => {
      if (!(opts.entitlementAllowed ?? true)) {
        throw new ForbiddenException(
          'Plan "Free" does not include capability "ai-suggestions". Upgrade to Personal or higher.',
        );
      }
    }),
  } as unknown as MockedObject<EntitlementsService>;

  const controller = new AiController(ai, aiSettings, cache, accounts, entitlements);

  return { controller, ai, aiSettings, cache, accounts, entitlements };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AiController.suggest", () => {
  it("returns AI suggestions on happy path", async () => {
    const { controller } = buildController({});
    const workspace = makeWorkspace("personal");

    const result = await controller.suggest(
      workspace,
      makeReq() as never,
      SUGGEST_BODY,
    );

    expect(result).toEqual(MOCK_SUGGESTIONS);
  });

  it("passes outputLanguage from request body to cache service (spec §17)", async () => {
    const { controller, cache } = buildController({});
    const workspace = makeWorkspace("personal");

    await controller.suggest(workspace, makeReq() as never, {
      url: "https://example.com",
      outputLanguage: "de",
    });

    expect(cache.suggestWithCache).toHaveBeenCalledWith(
      { workspaceId: "ws-1", userId: "user-1" },
      { url: "https://example.com", outputLanguage: "de" },
      expect.anything(),
    );
  });

  it("throws ForbiddenException when entitlement gate rejects (spec §12.4)", async () => {
    const { controller } = buildController({ entitlementAllowed: false });
    const workspace = makeWorkspace("free");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws ForbiddenException when user has opted out of AI", async () => {
    const { controller } = buildController({ aiOptOut: true });
    const workspace = makeWorkspace("personal");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws UnauthorizedException when account is not found", async () => {
    const { controller } = buildController({ accountFound: false });
    const workspace = makeWorkspace("personal");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws ServiceUnavailableException when AI provider is not configured", async () => {
    const { controller } = buildController({ aiAvailable: false });
    const workspace = makeWorkspace("personal");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("throws ServiceUnavailableException when workspace AI is disabled", async () => {
    const { controller } = buildController({ workspaceEnabled: false });
    const workspace = makeWorkspace("personal");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("does not call cache when entitlement gate fails", async () => {
    const { controller, cache } = buildController({ entitlementAllowed: false });
    const workspace = makeWorkspace("free");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(cache.suggestWithCache).not.toHaveBeenCalled();
  });

  it("does not call cache when user opted out", async () => {
    const { controller, cache } = buildController({ aiOptOut: true });
    const workspace = makeWorkspace("personal");

    await expect(
      controller.suggest(workspace, makeReq() as never, SUGGEST_BODY),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(cache.suggestWithCache).not.toHaveBeenCalled();
  });
});
