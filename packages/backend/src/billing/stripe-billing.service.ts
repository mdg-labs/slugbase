import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  BillingProviderError,
  BillingSeatFloorError,
  BillingUnavailableError,
  type BillingAsyncEvent,
  type BillingCheckoutRequest,
  type BillingCheckoutSession,
  type BillingEventResult,
  type BillingPortalRequest,
  type BillingPortalSession,
  type BillingSeatQuantityRequest,
  type BillingService,
  type BillingSubscriptionLookup,
  type BillingSubscriptionState,
} from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";
import { STRIPE_CLIENT } from "./billing.tokens.js";
import {
  checkoutSessionFromStripeObject,
  mapStripeSubscriptionToState,
  mapSupporterCheckoutToState,
  parseStripeEvent,
  subscriptionFromStripeObject,
  type StripeCheckoutSessionLike,
  type StripePortalSessionLike,
  type StripeSubscriptionLike,
} from "./stripe-billing.mapper.js";

/** Minimal Stripe SDK surface used by {@link StripeBillingService}. */
export interface StripeBillingClient {
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<StripeCheckoutSessionLike>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Record<string, unknown>): Promise<StripePortalSessionLike>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscriptionLike>;
    update(id: string, params: Record<string, unknown>): Promise<StripeSubscriptionLike>;
  };
}

/**
 * Stripe billing implementation — used when STRIPE_SECRET_KEY is configured (spec §11.4).
 * Maps Stripe subscription/checkout state to the product billing contract.
 */
@Injectable()
export class StripeBillingService implements BillingService {
  private readonly logger = new Logger(StripeBillingService.name);

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeBillingClient,
  ) {}

  isAvailable(): boolean {
    return this.hasStripeKey();
  }

  isPlanGatingEnabled(): boolean {
    return this.hasStripeKey();
  }

  async createCheckoutSession(
    request: BillingCheckoutRequest,
  ): Promise<BillingCheckoutSession> {
    this.assertAvailable();

    try {
      const teamBaseSeats = this.config.get("TEAM_BASE_SEATS");
      const isTeamRecurring = request.mode === "recurring" && request.plan === "team";

      const session = await this.stripe.checkout.sessions.create({
        mode: request.mode === "one_time" ? "payment" : "subscription",
        line_items: [
          {
            price: request.priceId,
            quantity: isTeamRecurring ? teamBaseSeats : 1,
          },
        ],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        customer: request.externalCustomerId ?? undefined,
        customer_email: request.externalCustomerId ? undefined : request.customerEmail,
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        metadata: {
          workspace_id: request.workspaceId,
          plan: request.plan,
          ...(request.mode === "one_time"
            ? { permanent_personal: "true", supporter: "true" }
            : {}),
        },
        subscription_data:
          request.mode === "recurring"
            ? {
                metadata: {
                  workspace_id: request.workspaceId,
                  plan: request.plan,
                  ...(request.plan === "team"
                    ? { included_seats: String(teamBaseSeats) }
                    : {}),
                },
              }
            : undefined,
      });

      if (!session.url) {
        throw new BillingProviderError("Stripe checkout session did not return a URL");
      }

      return { checkoutUrl: session.url, sessionId: session.id };
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      throw new BillingProviderError("Failed to create Stripe checkout session", error);
    }
  }

  async createPortalSession(request: BillingPortalRequest): Promise<BillingPortalSession> {
    this.assertAvailable();

    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: request.externalCustomerId,
        return_url: request.returnUrl,
      });
      return { portalUrl: session.url };
    } catch (error) {
      throw new BillingProviderError("Failed to create Stripe billing portal session", error);
    }
  }

  async getSubscriptionState(
    lookup: BillingSubscriptionLookup,
  ): Promise<BillingSubscriptionState> {
    this.assertAvailable();

    if (!lookup.externalSubscriptionId) {
      return {
        workspaceId: lookup.workspaceId,
        plan: "free",
        status: "none",
        externalCustomerId: lookup.externalCustomerId ?? null,
        externalSubscriptionId: null,
        currentPeriodEnd: null,
        includedSeats: null,
        extraSeats: 0,
        permanentPersonal: false,
        planGatingEnabled: true,
      };
    }

    try {
      const subscription = await this.stripe.subscriptions.retrieve(
        lookup.externalSubscriptionId,
      );
      return mapStripeSubscriptionToState(lookup.workspaceId, subscription);
    } catch (error) {
      throw new BillingProviderError("Failed to retrieve Stripe subscription", error);
    }
  }

  async updateSeatQuantity(
    request: BillingSeatQuantityRequest,
  ): Promise<BillingSubscriptionState> {
    this.assertAvailable();

    if (request.totalSeats < request.currentMemberCount) {
      throw new BillingSeatFloorError(request.totalSeats, request.currentMemberCount);
    }

    try {
      const current = await this.stripe.subscriptions.retrieve(request.externalSubscriptionId);
      const firstItem = current.items?.data?.[0];
      const itemId = firstItem?.id;
      if (!itemId) {
        throw new BillingProviderError("Stripe subscription has no line items");
      }

      const subscription = await this.stripe.subscriptions.update(request.externalSubscriptionId, {
        items: [{ id: itemId, quantity: request.totalSeats }],
      });

      return mapStripeSubscriptionToState(request.workspaceId, subscription);
    } catch (error) {
      if (error instanceof BillingSeatFloorError || error instanceof BillingProviderError) {
        throw error;
      }
      throw new BillingProviderError("Failed to update Stripe seat quantity", error);
    }
  }

  handleAsyncEvent(event: BillingAsyncEvent): Promise<BillingEventResult> {
    this.assertAvailable();

    const stripeEvent = parseStripeEvent(event.payload);
    if (!stripeEvent) {
      this.logger.warn("Unrecognized billing event payload", { eventId: event.eventId });
      return Promise.resolve({ processed: false, stateUpdated: false });
    }

    switch (stripeEvent.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = subscriptionFromStripeObject(stripeEvent.data.object);
        if (!subscription) {
          return Promise.resolve({ processed: true, stateUpdated: false });
        }
        const workspaceId =
          subscription.metadata?.workspace_id ??
          subscription.metadata?.workspaceId ??
          null;
        if (!workspaceId) {
          this.logger.warn("Stripe subscription event missing workspace metadata", {
            eventId: event.eventId,
            subscriptionId: subscription.id,
          });
          return Promise.resolve({ processed: true, stateUpdated: false });
        }
        const subscriptionState = mapStripeSubscriptionToState(workspaceId, subscription);
        return Promise.resolve({ processed: true, stateUpdated: true, subscriptionState });
      }
      case "checkout.session.completed": {
        const checkout = checkoutSessionFromStripeObject(stripeEvent.data.object);
        if (!checkout?.workspaceId) {
          return Promise.resolve({ processed: true, stateUpdated: false });
        }
        if (checkout.mode === "payment") {
          return Promise.resolve({
            processed: true,
            stateUpdated: true,
            subscriptionState: mapSupporterCheckoutToState(
              checkout.workspaceId,
              checkout.customerId,
            ),
          });
        }
        return Promise.resolve({ processed: true, stateUpdated: false });
      }
      default:
        return Promise.resolve({ processed: true, stateUpdated: false });
    }
  }

  private hasStripeKey(): boolean {
    const key = this.config.get("STRIPE_SECRET_KEY");
    return typeof key === "string" && key.length > 0;
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new BillingUnavailableError();
    }
  }
}
