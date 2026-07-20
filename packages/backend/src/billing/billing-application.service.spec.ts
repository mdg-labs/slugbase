import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import type { DbService } from "../db/db.service.js";
import { BillingApplicationService } from "./billing-application.service.js";
import type { BillingService } from "@slugbase/shared-types";
import type { AccountsService } from "../accounts/accounts.service.js";
import { PlanConfigService } from "./plans/plan-config.service.js";
import { WorkspaceMemberRepository } from "../workspaces/workspace-member.repository.js";
import { WorkspaceRepository } from "../workspaces/workspace.repository.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";

function createMockBilling(): BillingService {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    isPlanGatingEnabled: vi.fn().mockReturnValue(true),
    createCheckoutSession: vi.fn(),
    getSubscriptionState: vi.fn(),
    updateSeatQuantity: vi.fn(),
    cancelSubscription: vi.fn(),
    reactivateSubscription: vi.fn(),
    changePlan: vi.fn(),
    createPaymentMethodUpdateSession: vi.fn(),
    handleAsyncEvent: vi.fn().mockResolvedValue({ processed: true, stateUpdated: false }),
    listInvoices: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    }),
  };
}

function createMockConfig(overrides: Record<string, string | boolean | undefined> = {}): ConfigService {
  const values: Record<string, string | boolean | undefined> = {
    FRONTEND_ORIGIN: "https://app.slugbase.test",
    isProduction: false,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

const frontendSuccessUrl = "https://app.slugbase.test/billing/success";
const frontendCancelUrl = "https://app.slugbase.test/billing/cancel";

function createCheckoutService(overrides: {
  billing?: BillingService;
  memberCount?: number;
} = {}) {
  const billing = overrides.billing ?? createMockBilling();
  const config = createMockConfig();
  const mockOrm = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
  };
  const db = { getOrm: () => mockOrm } as unknown as DbService;
  const planConfig = {
    isSupporterPromotionActive: () => true,
    resolveCheckoutPriceId: () => "price_team",
  } as unknown as PlanConfigService;
  const accounts = {
    findById: vi.fn().mockResolvedValue({ id: "user-1", email: "owner@example.com" }),
  } as unknown as AccountsService;

  vi.spyOn(WorkspaceRepository.prototype, "findById").mockResolvedValue(workspaceFixture);
  vi.spyOn(WorkspaceMemberRepository.prototype, "findByWorkspaceAndUser").mockResolvedValue({
    id: "m-1",
    workspaceId: "ws-1",
    userId: "user-1",
    role: "OWNER",
    joinedAt: new Date(),
  });
  const memberCount = overrides.memberCount ?? 1;
  vi.spyOn(WorkspaceMemberRepository.prototype, "findAllByWorkspace").mockResolvedValue(
    Array.from({ length: memberCount }, (_, index) => ({
      id: `m-${String(index)}`,
      workspaceId: "ws-1",
      userId: `user-${String(index)}`,
      role: index === 0 ? "OWNER" : "MEMBER",
      joinedAt: new Date(),
    })) as never,
  );

  const service = new BillingApplicationService(
    db,
    billing,
    planConfig,
    config,
    accounts,
  );

  return { service, billing };
}

const workspaceFixture: WorkspaceRecord = {
  id: "ws-1",
  name: "Test WS",
  slug: "test-ws",
  plan: "free",
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

describe("BillingApplicationService - Team seat quantity", () => {
  it("rejects Team checkout when seatQuantity is below TEAM_MIN_SEATS", async () => {
    const { service } = createCheckoutService();

    await expect(
      service.startCheckout({
        workspaceId: "ws-1",
        requesterId: "user-1",
        plan: "team",
        mode: "recurring",
        seatQuantity: 1,
        successUrl: frontendSuccessUrl,
        cancelUrl: frontendCancelUrl,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects Team checkout when seatQuantity is below member count", async () => {
    const { service } = createCheckoutService({ memberCount: 4 });

    await expect(
      service.startCheckout({
        workspaceId: "ws-1",
        requesterId: "user-1",
        plan: "team",
        mode: "recurring",
        seatQuantity: 3,
        successUrl: frontendSuccessUrl,
        cancelUrl: frontendCancelUrl,
      }),
    ).rejects.toThrow(/below current member count/i);
  });

  it("passes validated seatQuantity to billing on Team checkout", async () => {
    const billing = createMockBilling();
    (billing.createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      checkoutUrl: "https://checkout.example.test/session",
      sessionId: "cs_test",
    });
    const { service } = createCheckoutService({ billing });

    await service.startCheckout({
      workspaceId: "ws-1",
      requesterId: "user-1",
      plan: "team",
      mode: "recurring",
      seatQuantity: 5,
      successUrl: frontendSuccessUrl,
      cancelUrl: frontendCancelUrl,
    });

    expect(billing.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ seatQuantity: 5 }),
    );
  });
});

describe("BillingApplicationService - redirect URL allowlist", () => {
  it("rejects checkout when successUrl is off-origin", async () => {
    const billing = createMockBilling();
    const { service } = createCheckoutService({ billing });

    await expect(
      service.startCheckout({
        workspaceId: "ws-1",
        requesterId: "user-1",
        plan: "personal",
        mode: "recurring",
        successUrl: "https://evil.example/success",
        cancelUrl: frontendCancelUrl,
      }),
    ).rejects.toThrow(/frontend origin/i);

    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects checkout when cancelUrl is off-origin", async () => {
    const billing = createMockBilling();
    const { service } = createCheckoutService({ billing });

    await expect(
      service.startCheckout({
        workspaceId: "ws-1",
        requesterId: "user-1",
        plan: "personal",
        mode: "recurring",
        successUrl: frontendSuccessUrl,
        cancelUrl: "https://evil.example/cancel",
      }),
    ).rejects.toThrow(/frontend origin/i);

    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("allows redirect URLs on the configured frontend origin", async () => {
    const billing = createMockBilling();
    (billing.createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      checkoutUrl: "https://checkout.example.test/session",
      sessionId: "cs_test",
    });
    const { service } = createCheckoutService({ billing });

    await service.startCheckout({
      workspaceId: "ws-1",
      requesterId: "user-1",
      plan: "personal",
      mode: "recurring",
      successUrl: frontendSuccessUrl,
      cancelUrl: frontendCancelUrl,
    });

    expect(billing.createCheckoutSession).toHaveBeenCalledOnce();
  });

  it("rejects non-HTTPS redirect URLs in production", async () => {
    const billing = createMockBilling();
    const productionConfig = createMockConfig({
      FRONTEND_ORIGIN: "http://localhost:3000",
      isProduction: true,
    });
    const mockOrm = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
    };
    const db = { getOrm: () => mockOrm } as unknown as DbService;
    const planConfig = {
      isSupporterPromotionActive: () => true,
      resolveCheckoutPriceId: () => "price_personal",
    } as unknown as PlanConfigService;
    const accounts = {
      findById: vi.fn().mockResolvedValue({ id: "user-1", email: "owner@example.com" }),
    } as unknown as AccountsService;

    vi.spyOn(WorkspaceMemberRepository.prototype, "findByWorkspaceAndUser").mockResolvedValue({
      id: "m-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "OWNER",
      joinedAt: new Date(),
    });

    const productionService = new BillingApplicationService(
      db,
      billing,
      planConfig,
      productionConfig,
      accounts,
    );

    await expect(
      productionService.startCheckout({
        workspaceId: "ws-1",
        requesterId: "user-1",
        plan: "personal",
        mode: "recurring",
        successUrl: "http://localhost:3000/billing/success",
        cancelUrl: "http://localhost:3000/billing/cancel",
      }),
    ).rejects.toThrow(/HTTPS in production/i);

    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });
});
