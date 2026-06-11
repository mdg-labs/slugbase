import { Injectable, Logger } from "@nestjs/common";
import {
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

/**
 * No-op billing implementation - used when STRIPE_SECRET_KEY is not configured.
 * Grants full/unlimited entitlements via planGatingEnabled=false (spec §11.4–§11.5).
 * Checkout, portal, and seat adjustments are unavailable.
 */
@Injectable()
export class NoopBillingService implements BillingService {
  private readonly logger = new Logger(NoopBillingService.name);

  isAvailable(): boolean {
    return false;
  }

  isPlanGatingEnabled(): boolean {
    return false;
  }

  createCheckoutSession(_request: BillingCheckoutRequest): Promise<BillingCheckoutSession> {
    return Promise.reject(new BillingUnavailableError());
  }

  createPortalSession(_request: BillingPortalRequest): Promise<BillingPortalSession> {
    return Promise.reject(new BillingUnavailableError());
  }

  getSubscriptionState(lookup: BillingSubscriptionLookup): Promise<BillingSubscriptionState> {
    return Promise.resolve({
      workspaceId: lookup.workspaceId,
      plan: "team",
      status: "none",
      billingInterval: null,
      externalCustomerId: null,
      externalSubscriptionId: null,
      currentPeriodEnd: null,
      includedSeats: null,
      extraSeats: 0,
      permanentPersonal: false,
      planGatingEnabled: false,
    });
  }

  updateSeatQuantity(_request: BillingSeatQuantityRequest): Promise<BillingSubscriptionState> {
    return Promise.reject(new BillingUnavailableError());
  }

  handleAsyncEvent(event: BillingAsyncEvent): Promise<BillingEventResult> {
    this.logger.warn("Billing provider not configured - ignoring async event", {
      eventId: event.eventId,
    });
    return Promise.resolve({ processed: true, stateUpdated: false });
  }
}
