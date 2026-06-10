import "reflect-metadata";

import {
  ForbiddenException,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BillingApplicationService } from "../src/billing/billing-application.service.js";
import {
  STRIPE_CLIENT,
} from "../src/billing/billing.tokens.js";
import type { StripeBillingClient } from "../src/billing/stripe-billing.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

function teamSubscriptionPayload(workspaceId: string, quantity = 5) {
  return {
    id: "evt_team_upgrade",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_team_1",
        object: "subscription",
        status: "active",
        current_period_end: 1_735_689_600,
        customer: "cus_team_1",
        metadata: {
          workspace_id: workspaceId,
          plan: "team",
          included_seats: "5",
        },
        items: {
          data: [{ id: "si_1", quantity, price: { metadata: { plan: "team" } } }],
        },
      },
    },
  };
}

describe("Billing (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let billingApp: BillingApplicationService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;
  let ownerUserId: string;
  let memberUserId: string;
  let workspaceId: string;

  const stripeClient: StripeBillingClient = {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_test",
          url: "https://checkout.stripe.test/session",
        }),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          url: "https://billing.stripe.test/portal",
        }),
      },
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: "sub_team_1",
        customer: "cus_team_1",
        status: "active",
        current_period_end: 1_735_689_600,
        metadata: { workspace_id: "ws-placeholder", plan: "team", included_seats: "5" },
        items: {
          data: [{ id: "si_1", quantity: 5, price: { metadata: { plan: "team" } } }],
        },
      }),
      update: vi.fn().mockImplementation((_id: string, params: Record<string, unknown>) => {
        const items = params.items as Array<{ quantity: number }> | undefined;
        const quantity = items?.[0]?.quantity ?? 5;
        return Promise.resolve({
          id: "sub_team_1",
          customer: "cus_team_1",
          status: "active",
          current_period_end: 1_735_689_600,
          metadata: { workspace_id: workspaceId, plan: "team", included_seats: "5" },
          items: {
            data: [
              {
                id: "si_1",
                quantity,
                price: { metadata: { plan: "team" } },
              },
            ],
          },
        });
      }),
    },
    prices: {
      retrieve: vi.fn().mockResolvedValue({
        id: "price_test",
        unit_amount: 300,
        currency: "eur",
        type: "recurring",
        recurring: { interval: "month" },
      }),
    },
  };

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_billing_integration",
      STRIPE_WEBHOOK_SECRET: "whsec_test_billing_integration",
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_personal_monthly_test",
      STRIPE_PRICE_PERSONAL_ANNUAL: "price_personal_annual_test",
      STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly_test",
      STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual_test",
      STRIPE_PRICE_SUPPORTER: "price_supporter_test",
      TEAM_BASE_SEATS: "5",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STRIPE_CLIENT)
      .useValue(stripeClient)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    billingApp = moduleRef.get(BillingApplicationService);
    workspacesService = moduleRef.get(WorkspacesService);
    membersService = moduleRef.get(WorkspaceMembersService);

    const accountsService = moduleRef.get(AccountsService);
    const owner = await accountsService.registerAccount({
      email: "billing-owner@example.com",
      name: "Billing Owner",
      password: "password-abc-123",
    });
    ownerUserId = owner.id;

    const member = await accountsService.registerAccount({
      email: "billing-member@example.com",
      name: "Billing Member",
      password: "password-abc-123",
    });
    memberUserId = member.id;

    const workspace = await workspacesService.createWorkspace(
      { name: "Billing WS", slug: "billing-ws" },
      ownerUserId,
    );
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  it("applies subscription webhook events idempotently via dedupe store", async () => {
    const payload = {
      id: "evt_billing_idempotent",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_personal_1",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_personal_1",
          metadata: { workspace_id: workspaceId, plan: "personal" },
        },
      },
    };

    const first = await billingApp.applyBillingEvent({
      eventId: "evt_billing_idempotent",
      payload,
    });
    const second = await billingApp.applyBillingEvent({
      eventId: "evt_billing_idempotent",
      payload,
    });

    expect(first).toEqual({ processed: true, stateUpdated: true });
    expect(second).toEqual({ processed: true, stateUpdated: false });

    const workspace = await workspacesService.getWorkspace(workspaceId);
    expect(workspace.plan).toBe("personal");
    expect(workspace.billingCustomerId).toBe("cus_personal_1");
    expect(workspace.billingSubscriptionId).toBe("sub_personal_1");
    expect(workspace.billingStatus).toBe("active");
  });

  it("enforces seat floor when reducing Team seats below member count", async () => {
    await billingApp.applyBillingEvent({
      eventId: "evt_team_seats_floor",
      payload: teamSubscriptionPayload(workspaceId),
    });

    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);
    const members = await membersService.listMembers(workspaceId);
    expect(members.length).toBeGreaterThanOrEqual(2);

    await expect(
      billingApp.updateSeats({
        workspaceId,
        requesterId: ownerUserId,
        totalSeats: 1,
      }),
    ).rejects.toThrow(/cannot be below current member count/i);
  });

  it("blocks workspace deletion while active paid billing is unresolved", async () => {
    await billingApp.applyBillingEvent({
      eventId: "evt_team_delete_guard",
      payload: teamSubscriptionPayload(workspaceId),
    });

    const workspace = await workspacesService.getWorkspace(workspaceId);
    expect(workspace.plan).toBe("team");

    await expect(
      workspacesService.deleteWorkspace(workspaceId, ownerUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("starts checkout and opens portal for workspace owner", async () => {
    const checkout = await billingApp.startCheckout({
      workspaceId,
      requesterId: ownerUserId,
      plan: "personal",
      mode: "recurring",
      billingInterval: "monthly",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    });
    expect(checkout.checkoutUrl).toContain("checkout.stripe.test");

    const portal = await billingApp.openPortal({
      workspaceId,
      requesterId: ownerUserId,
      returnUrl: "https://app.example/settings/billing",
    });
    expect(portal.portalUrl).toContain("billing.stripe.test");
  });

  it("resolves annual price ID when billingInterval is annual", async () => {
    const checkout = await billingApp.startCheckout({
      workspaceId,
      requesterId: ownerUserId,
      plan: "personal",
      mode: "recurring",
      billingInterval: "annual",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    });
    expect(checkout.checkoutUrl).toContain("checkout.stripe.test");
  });

  it("subscription state includes billingInterval when set", async () => {
    const evtMonthly = {
      id: "evt_interval_monthly",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_monthly_1",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_interval_1",
          metadata: { workspace_id: workspaceId, plan: "personal" },
          items: {
            data: [{
              id: "si_monthly",
              quantity: 1,
              price: {
                metadata: { plan: "personal", billing_interval: "monthly" },
                recurring: { interval: "month" },
              },
            }],
          },
        },
      },
    };

    await billingApp.applyBillingEvent({ eventId: "evt_interval_monthly", payload: evtMonthly });

    const evtAnnual = {
      id: "evt_interval_annual",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_annual_1",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_interval_2",
          metadata: { workspace_id: workspaceId, plan: "team", included_seats: "5" },
          items: {
            data: [{
              id: "si_annual",
              quantity: 5,
              price: {
                metadata: { plan: "team", billing_interval: "annual" },
                recurring: { interval: "year" },
              },
            }],
          },
        },
      },
    };

    await billingApp.applyBillingEvent({ eventId: "evt_interval_annual", payload: evtAnnual });

    const workspace = await workspacesService.getWorkspace(workspaceId);
    expect(workspace.plan).toBe("team");
  });

  it("returns { received: true } for webhook events without product marker (no processing)", async () => {
    const noMarkerPayload = {
      id: "evt_no_product_marker",
      type: "invoice.payment_succeeded",
      data: { object: { id: "in_irrelevant", metadata: {} } },
    };

    const rawBody = Buffer.from(JSON.stringify(noMarkerPayload));
    const result = await billingApp.processWebhookEvent(rawBody, "sig_test_no_marker");

    expect(result).toEqual({ received: true });
  });

  it("returns { received: true } for events with a wrong product marker", async () => {
    const wrongMarkerPayload = {
      id: "evt_wrong_marker",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_wrong",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_wrong",
          metadata: { workspace_id: "ws-1", plan: "personal", product: "other-service" },
        },
      },
    };

    const rawBody = Buffer.from(JSON.stringify(wrongMarkerPayload));
    const result = await billingApp.processWebhookEvent(rawBody, "sig_test_wrong_marker");

    expect(result).toEqual({ received: true });
  });
});
