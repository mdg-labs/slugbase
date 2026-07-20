import "reflect-metadata";

import {
  ForbiddenException,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BillingUnavailableError } from "@slugbase/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AccountsService } from "../src/accounts/accounts.service.js";
import { BillingApplicationService } from "../src/billing/billing-application.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { WorkspaceMembersService } from "../src/workspaces/workspace-members.service.js";
import { WorkspacesService } from "../src/workspaces/workspaces.service.js";
import { createTestDatabase } from "./test-database.js";

describe("Billing (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};
  let billingApp: BillingApplicationService;
  let workspacesService: WorkspacesService;
  let membersService: WorkspaceMembersService;
  let ownerUserId: string;
  let memberUserId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

  it("rejects checkout when billing provider is unavailable", async () => {
    await expect(
      billingApp.startCheckout({
        workspaceId,
        requesterId: ownerUserId,
        plan: "personal",
        mode: "recurring",
        billingInterval: "monthly",
        successUrl: "https://app.slugbase.test/success",
        cancelUrl: "https://app.slugbase.test/cancel",
      }),
    ).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it("rejects seat updates when billing provider is unavailable", async () => {
    await workspacesService.updateWorkspace(
      workspaceId,
      {
        plan: "team",
        billingSubscriptionId: "sub_test",
        billingStatus: "active",
      },
      ownerUserId,
    );

    await expect(
      billingApp.updateSeats({
        workspaceId,
        requesterId: ownerUserId,
        totalSeats: 5,
      }),
    ).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it("blocks workspace deletion while active paid billing is unresolved", async () => {
    await workspacesService.updateWorkspace(
      workspaceId,
      {
        plan: "team",
        billingSubscriptionId: "sub_team_guard",
        billingStatus: "active",
      },
      ownerUserId,
    );

    const workspace = await workspacesService.getWorkspace(workspaceId);
    expect(workspace.plan).toBe("team");

    await expect(
      workspacesService.deleteWorkspace(workspaceId, ownerUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("returns empty invoice list when workspace has no billing customer", async () => {
    const emptyWorkspace = await workspacesService.createWorkspace(
      { name: "No Billing WS", slug: "no-billing-ws" },
      ownerUserId,
    );

    const invoices = await billingApp.listInvoices({
      workspaceId: emptyWorkspace.id,
      requesterId: ownerUserId,
    });

    expect(invoices).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  });

  it("rejects seat updates when billing provider is unavailable (seat floor pre-check skipped)", async () => {
    await workspacesService.updateWorkspace(
      workspaceId,
      {
        plan: "team",
        billingSubscriptionId: "sub_team_floor",
        billingStatus: "active",
      },
      ownerUserId,
    );

    await membersService.addMember(workspaceId, memberUserId, "MEMBER", ownerUserId);

    await expect(
      billingApp.updateSeats({
        workspaceId,
        requesterId: ownerUserId,
        totalSeats: 1,
      }),
    ).rejects.toBeInstanceOf(BillingUnavailableError);
  });
});
