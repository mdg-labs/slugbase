import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import {
  BillingSeatFloorError,
  BillingUnavailableError,
  type BillingCheckoutMode,
  type BillingInterval,
  type BillingPlan,
  type BillingService,
} from "@slugbase/shared-types";

import { AccountsService } from "../accounts/accounts.service.js";
import { ConfigService } from "../config/config.service.js";
import { DbService } from "../db/db.service.js";
import { WorkspaceMemberRepository } from "../workspaces/workspace-member.repository.js";
import { WorkspaceRepository } from "../workspaces/workspace.repository.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { assertBillingRedirectUrlAllowed } from "./billing-redirect.util.js";
import { BILLING } from "./billing.tokens.js";
import { TEAM_MIN_SEATS } from "./plans/entitlement-sets.js";
import { PlanConfigService } from "./plans/plan-config.service.js";
import { subscriptionStateToWorkspacePatch } from "./workspace-billing.util.js";

export interface StartCheckoutInput {
  workspaceId: string;
  requesterId: string;
  plan: Exclude<BillingPlan, "free">;
  mode: BillingCheckoutMode;
  billingInterval?: BillingInterval;
  seatQuantity?: number;
  successUrl: string;
  cancelUrl: string;
}

export interface UpdateSeatsInput {
  workspaceId: string;
  requesterId: string;
  totalSeats: number;
}

export interface ListInvoicesInput {
  workspaceId: string;
  requesterId: string;
  page?: number;
  pageSize?: number;
}

/**
 * Orchestrates checkout, seat updates, and invoice listing (spec §11.4, §12.3).
 * CE uses NoopBillingService — checkout and seat changes are unavailable.
 */
@Injectable()
export class BillingApplicationService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly memberRepo: WorkspaceMemberRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(BILLING) private readonly billing: BillingService,
    @Inject(PlanConfigService) private readonly planConfig: PlanConfigService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {
    const orm = db.getOrm();
    this.workspaceRepo = new WorkspaceRepository(orm);
    this.memberRepo = new WorkspaceMemberRepository(orm);
  }

  assertBillingAvailable(): void {
    if (!this.billing.isAvailable()) {
      throw new BillingUnavailableError();
    }
  }

  async startCheckout(input: StartCheckoutInput): Promise<{ checkoutUrl: string; sessionId: string }> {
    this.assertBillingAvailable();
    this.assertBillingRedirectUrls([input.successUrl, input.cancelUrl]);
    await this.requireBillingOwner(input.workspaceId, input.requesterId);

    if (input.mode === "one_time" && !this.planConfig.isSupporterPromotionActive()) {
      throw new BadRequestException("Supporter promotion is no longer available");
    }

    const priceId = this.planConfig.resolveCheckoutPriceId(
      input.plan,
      input.mode,
      input.billingInterval,
    );
    if (!priceId) {
      throw new BadRequestException("Checkout is not configured for this plan");
    }

    const workspace = await this.workspaceRepo.findById(input.workspaceId);
    if (!workspace) {
      throw new BadRequestException("Workspace not found");
    }

    const account = await this.accounts.findById(input.requesterId);
    if (!account) {
      throw new ForbiddenException("Account not found");
    }

    let seatQuantity: number | undefined;
    if (input.plan === "team" && input.mode === "recurring") {
      const members = await this.memberRepo.findAllByWorkspace(input.workspaceId);
      const memberCount = members.length;
      const requested = input.seatQuantity ?? Math.max(memberCount, TEAM_MIN_SEATS);

      if (requested < TEAM_MIN_SEATS) {
        throw new BadRequestException(
          `Team checkout requires at least ${String(TEAM_MIN_SEATS)} seats`,
        );
      }
      if (requested < memberCount) {
        throw new BadRequestException(
          `Seat quantity (${String(requested)}) cannot be below current member count (${String(memberCount)})`,
        );
      }
      seatQuantity = requested;
    }

    return this.billing.createCheckoutSession({
      workspaceId: input.workspaceId,
      plan: input.plan,
      mode: input.mode,
      priceId,
      billingInterval: input.billingInterval,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      customerEmail: account.email,
      externalCustomerId: workspace.billingCustomerId,
      seatQuantity,
    });
  }

  async updateSeats(input: UpdateSeatsInput): Promise<WorkspaceRecord> {
    this.assertBillingAvailable();
    await this.requireBillingOwner(input.workspaceId, input.requesterId);

    const workspace = await this.workspaceRepo.findById(input.workspaceId);
    if (!workspace) {
      throw new BadRequestException("Workspace not found");
    }
    if (workspace.plan !== "team") {
      throw new BadRequestException("Seat updates apply only to Team workspaces");
    }
    if (!workspace.billingSubscriptionId || !workspace.billingCustomerId) {
      throw new BadRequestException("No active Team subscription");
    }

    const members = await this.memberRepo.findAllByWorkspace(input.workspaceId);

    if (input.totalSeats < TEAM_MIN_SEATS) {
      throw new BadRequestException(
        `Team subscriptions require at least ${String(TEAM_MIN_SEATS)} seats`,
      );
    }

    try {
      const state = await this.billing.updateSeatQuantity({
        workspaceId: input.workspaceId,
        externalCustomerId: workspace.billingCustomerId,
        externalSubscriptionId: workspace.billingSubscriptionId,
        totalSeats: input.totalSeats,
        currentMemberCount: members.length,
      });

      const patch = subscriptionStateToWorkspacePatch(state);
      const updated = await this.workspaceRepo.update(input.workspaceId, patch);
      if (!updated) {
        throw new BadRequestException("Failed to update workspace billing state");
      }
      return updated;
    } catch (error) {
      if (error instanceof BillingSeatFloorError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async listInvoices(input: ListInvoicesInput) {
    await this.requireWorkspaceMember(input.workspaceId, input.requesterId);

    const workspace = await this.workspaceRepo.findById(input.workspaceId);
    if (!workspace?.billingCustomerId) {
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      return {
        items: [],
        total: 0,
        page,
        pageSize,
        hasMore: false,
      };
    }

    return this.billing.listInvoices({
      workspaceId: input.workspaceId,
      externalCustomerId: workspace.billingCustomerId,
      page: input.page,
      pageSize: input.pageSize,
    });
  }

  private assertBillingRedirectUrls(urls: string[]): void {
    const frontendOrigin = this.config.get("FRONTEND_ORIGIN");
    const requireHttps = this.config.get("isProduction");
    for (const url of urls) {
      assertBillingRedirectUrlAllowed(url, frontendOrigin, requireHttps);
    }
  }

  private async requireBillingOwner(workspaceId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findByWorkspaceAndUser(workspaceId, userId);
    if (!member || member.role !== "OWNER") {
      throw new ForbiddenException("Only the workspace owner may manage billing");
    }
  }

  private async requireWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findByWorkspaceAndUser(workspaceId, userId);
    if (!member) {
      throw new ForbiddenException("Workspace membership required");
    }
  }
}
