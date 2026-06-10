import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import {
  BillingSeatFloorError,
  BillingUnavailableError,
  type BillingAsyncEvent,
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
import { BillingWebhookEventRepository } from "./billing-webhook-event.repository.js";
import { BILLING } from "./billing.tokens.js";
import { PlanConfigService } from "./plans/plan-config.service.js";
import {
  EXPECTED_PRODUCT_MARKER,
  parseStripeEvent,
  readProductMarker,
} from "./stripe-billing.mapper.js";
import { DowngradeService } from "./downgrade/downgrade.service.js";
import {
  subscriptionStateToWorkspacePatch,
} from "./workspace-billing.util.js";

export interface StartCheckoutInput {
  workspaceId: string;
  requesterId: string;
  plan: Exclude<BillingPlan, "free">;
  mode: BillingCheckoutMode;
  billingInterval?: BillingInterval;
  successUrl: string;
  cancelUrl: string;
}

export interface OpenPortalInput {
  workspaceId: string;
  requesterId: string;
  returnUrl: string;
}

export interface UpdateSeatsInput {
  workspaceId: string;
  requesterId: string;
  totalSeats: number;
}

/** Stripe webhook signature verifier surface. */
export interface StripeWebhookClient {
  webhooks: {
    constructEvent(
      payload: Buffer | string,
      signature: string,
      secret: string,
    ): unknown;
  };
}

export const STRIPE_WEBHOOK_CLIENT = Symbol("STRIPE_WEBHOOK_CLIENT");

/**
 * Orchestrates checkout, portal, seat updates, and idempotent webhook application
 * (spec §11.4, §12.3).
 */
@Injectable()
export class BillingApplicationService {
  private readonly logger = new Logger(BillingApplicationService.name);
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly memberRepo: WorkspaceMemberRepository;
  private readonly webhookEventRepo: BillingWebhookEventRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(BILLING) private readonly billing: BillingService,
    @Inject(PlanConfigService) private readonly planConfig: PlanConfigService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(STRIPE_WEBHOOK_CLIENT) private readonly stripeWebhook: StripeWebhookClient,
    @Inject(DowngradeService) private readonly downgrade: DowngradeService,
  ) {
    const orm = db.getOrm();
    this.workspaceRepo = new WorkspaceRepository(orm);
    this.memberRepo = new WorkspaceMemberRepository(orm);
    this.webhookEventRepo = new BillingWebhookEventRepository(orm);
  }

  assertBillingAvailable(): void {
    if (!this.billing.isAvailable()) {
      throw new BillingUnavailableError();
    }
  }

  async startCheckout(input: StartCheckoutInput): Promise<{ checkoutUrl: string; sessionId: string }> {
    this.assertBillingAvailable();
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

    return this.billing.createCheckoutSession({
      workspaceId: input.workspaceId,
      plan: input.plan,
      mode: input.mode,
      priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      customerEmail: account.email,
      externalCustomerId: workspace.billingCustomerId,
    });
  }

  async openPortal(input: OpenPortalInput): Promise<{ portalUrl: string }> {
    this.assertBillingAvailable();
    await this.requireBillingOwner(input.workspaceId, input.requesterId);

    const workspace = await this.workspaceRepo.findById(input.workspaceId);
    if (!workspace?.billingCustomerId) {
      throw new BadRequestException("No billing customer linked to this workspace");
    }

    return this.billing.createPortalSession({
      workspaceId: input.workspaceId,
      returnUrl: input.returnUrl,
      externalCustomerId: workspace.billingCustomerId,
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
    if (!workspace.billingSubscriptionId) {
      throw new BadRequestException("No active Team subscription");
    }

    const members = await this.memberRepo.findAllByWorkspace(input.workspaceId);

    try {
      const state = await this.billing.updateSeatQuantity({
        workspaceId: input.workspaceId,
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

  async processWebhookEvent(rawBody: Buffer, signature: string): Promise<{ received: true }> {
    this.assertBillingAvailable();

    // Check product marker in the raw payload BEFORE signature verification.
    // Events from non-slugbase Stripe accounts (or forwarded events) carry no
    // marker — acknowledge with 200 so Stripe stops retrying, but do not process.
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      throw new BadRequestException("Invalid webhook payload");
    }

    const productMarker = readProductMarker(rawPayload);
    if (productMarker !== EXPECTED_PRODUCT_MARKER) {
      const raw = rawPayload as Record<string, unknown>;
      this.logger.debug("Webhook event without product marker — ignoring", {
        eventTyp: typeof raw.type === "string" ? raw.type : undefined,
      });
      return { received: true };
    }

    const webhookSecret = this.config.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      throw new BillingUnavailableError("Stripe webhook secret is not configured");
    }

    let payload: unknown;
    try {
      payload = this.stripeWebhook.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (error) {
      this.logger.warn("Invalid Stripe webhook signature", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException("Invalid webhook signature");
    }

    const stripeEvent = parseStripeEvent(payload);
    if (!stripeEvent) {
      throw new BadRequestException("Unrecognized webhook payload");
    }

    await this.applyBillingEvent({
      eventId: stripeEvent.id,
      payload,
    });

    return { received: true };
  }

  async applyBillingEvent(event: BillingAsyncEvent): Promise<{ processed: boolean; stateUpdated: boolean }> {
    if (await this.webhookEventRepo.hasProcessed(event.eventId)) {
      return { processed: true, stateUpdated: false };
    }

    const result = await this.billing.handleAsyncEvent(event);
    if (!result.processed) {
      return { processed: false, stateUpdated: false };
    }

    const stripeEvent = parseStripeEvent(event.payload);
    const eventType = stripeEvent?.type ?? "unknown";

    if (result.stateUpdated && result.subscriptionState) {
      await this.applySubscriptionState(result.subscriptionState);
    }

    await this.webhookEventRepo.recordProcessed(event.eventId, eventType);
    return { processed: true, stateUpdated: result.stateUpdated };
  }

  async applySubscriptionState(
    state: Parameters<typeof subscriptionStateToWorkspacePatch>[0],
  ): Promise<WorkspaceRecord | null> {
    const previous = await this.workspaceRepo.findById(state.workspaceId);
    const patch = subscriptionStateToWorkspacePatch(state);
    const updated = await this.workspaceRepo.update(state.workspaceId, patch);
    if (updated) {
      await this.downgrade.handlePlanTransition(previous, updated);
    }
    return updated;
  }

  private async requireBillingOwner(workspaceId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findByWorkspaceAndUser(workspaceId, userId);
    if (!member || member.role !== "OWNER") {
      throw new ForbiddenException("Only the workspace owner may manage billing");
    }
  }
}
