import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import type { DbService } from "../db/db.service.js";
import { BillingApplicationService } from "./billing-application.service.js";
import type { BillingService } from "@slugbase/shared-types";
import type { AccountsService } from "../accounts/accounts.service.js";
import { PlanConfigService } from "./plans/plan-config.service.js";
import { DowngradeService } from "./downgrade/downgrade.service.js";
import { WorkspaceMemberRepository } from "../workspaces/workspace-member.repository.js";
import { WorkspaceRepository } from "../workspaces/workspace.repository.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";

function createStripeEventPayload(
  overrides: { data?: { object?: Record<string, unknown> } } & Record<string, unknown> = {},
) {
  return {
    id: "evt_test_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        object: "subscription",
        status: "active",
        current_period_end: 1_735_689_600,
        customer: "cus_1",
        metadata: {
          workspace_id: "ws-1",
          plan: "personal",
          product: "slugbase",
          ...(overrides.data?.object?.metadata as Record<string, unknown> | undefined ?? {}),
        },
        ...(overrides.data?.object ?? {}),
      },
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "data")),
  };
}

function createMockBilling(): BillingService {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    isPlanGatingEnabled: vi.fn().mockReturnValue(true),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    getSubscriptionState: vi.fn(),
    updateSeatQuantity: vi.fn(),
    handleAsyncEvent: vi.fn().mockResolvedValue({ processed: true, stateUpdated: false }),
  };
}

function createMockWebhookClient() {
  return {
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

function createMockConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    ...overrides,
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

function createService(overrides: {
  billing?: BillingService;
  config?: ConfigService;
} = {}) {
  const billing = overrides.billing ?? createMockBilling();
  const webhookClient = createMockWebhookClient();
  const config = overrides.config ?? createMockConfig();

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
    resolveCheckoutPriceId: () => "price_test",
  } as unknown as PlanConfigService;
  const accounts = { findById: vi.fn() } as unknown as AccountsService;
  const downgrade = { handlePlanTransition: vi.fn() } as unknown as DowngradeService;

  const service = new BillingApplicationService(
    db,
    billing,
    planConfig,
    config,
    accounts,
    webhookClient,
    downgrade,
  );

  return { service, billing, webhookClient, mockOrm };
}

describe("BillingApplicationService - webhook product marker", () => {
  it("returns { received: true } for events without product marker", async () => {
    const { service } = createService();

    const payload = {
      id: "evt_no_product",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_1",
          metadata: { workspace_id: "ws-1", plan: "personal" },
        },
      },
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await service.processWebhookEvent(rawBody, "sig_test");

    expect(result).toEqual({ received: true });
  });

  it("returns { received: true } for events with wrong product marker", async () => {
    const { service } = createService();

    const payload = {
      id: "evt_wrong_product",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_1",
          metadata: { workspace_id: "ws-1", plan: "personal", product: "other-product" },
        },
      },
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await service.processWebhookEvent(rawBody, "sig_test");

    expect(result).toEqual({ received: true });
  });

  it("proceeds with processing when product marker is slugbase", async () => {
    const { service, webhookClient, mockOrm } = createService();

    const payload = createStripeEventPayload();
    const constructEventMock = webhookClient.webhooks.constructEvent as ReturnType<typeof vi.fn>;
    constructEventMock.mockReturnValue(payload);
    mockOrm.limit.mockResolvedValue([]);

    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await service.processWebhookEvent(rawBody, "sig_test");

    expect(result).toEqual({ received: true });
    expect(constructEventMock).toHaveBeenCalledWith(
      rawBody,
      "sig_test",
      "whsec_test",
    );
  });

  it("events without marker are not forwarded to constructEvent", async () => {
    const { service, webhookClient } = createService();

    const payload = {
      id: "evt_no_marker",
      type: "invoice.payment_succeeded",
      data: { object: { id: "in_1", metadata: {} } },
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    await service.processWebhookEvent(rawBody, "sig_test");

    const constructEventMock = webhookClient.webhooks.constructEvent as ReturnType<typeof vi.fn>;
    expect(constructEventMock).not.toHaveBeenCalled();
  });

  it("returns { received: true } for events with empty metadata", async () => {
    const { service, webhookClient } = createService();

    const payload = {
      id: "evt_empty_meta",
      type: "customer.subscription.updated",
      data: { object: {} },
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await service.processWebhookEvent(rawBody, "sig_test");

    expect(result).toEqual({ received: true });
    const constructEventMock = webhookClient.webhooks.constructEvent as ReturnType<typeof vi.fn>;
    expect(constructEventMock).not.toHaveBeenCalled();
  });
});

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

function createCheckoutService(overrides: {
  billing?: BillingService;
  memberCount?: number;
} = {}) {
  const billing = overrides.billing ?? createMockBilling();
  const webhookClient = createMockWebhookClient();
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
  const downgrade = { handlePlanTransition: vi.fn() } as unknown as DowngradeService;

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
    webhookClient,
    downgrade,
  );

  return { service, billing };
}

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
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
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
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
      }),
    ).rejects.toThrow(/below current member count/i);
  });

  it("passes validated seatQuantity to billing on Team checkout", async () => {
    const billing = createMockBilling();
    (billing.createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.test/session",
      sessionId: "cs_test",
    });
    const { service } = createCheckoutService({ billing });

    await service.startCheckout({
      workspaceId: "ws-1",
      requesterId: "user-1",
      plan: "team",
      mode: "recurring",
      seatQuantity: 5,
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    });

    expect(billing.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ seatQuantity: 5 }),
    );
  });
});
